#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';

const PROJECT_ID = 'studio-8612233125-caa0a';
const STORAGE_BUCKET = 'studio-8612233125-caa0a.firebasestorage.app';
const HOSTS = {
  app: process.env.NEXO_LOCAL_APP_HOST || '127.0.0.1:9002',
  auth: process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099',
  firestore: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
  functions: process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001',
  storage: process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199',
};

process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT_ID;
process.env.GCLOUD_PROJECT ||= PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST ||= HOSTS.firestore;

const require = createRequire(import.meta.url);
const { Firestore } = require('../functions/node_modules/@google-cloud/firestore');
const db = new Firestore({ projectId: PROJECT_ID });

const COLECOES = [
  { nome: 'nexo_sync_state', campoAtualizacao: 'coletadoEm' },
  { nome: 'nexo_alertas', campoAtualizacao: 'ultimaDeteccaoEm' },
  { nome: 'nexo_despesa_sintetica', campoAtualizacao: '_coletadoEm' },
  { nome: 'nexo_contratos_pncp', campoAtualizacao: '_coletadoEm' },
  { nome: 'nexo_snapshots', campoAtualizacao: 'geradoEm' },
  { nome: 'nexo_tarefas', campoAtualizacao: 'concluidoEm' },
];

function decodeValor(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue?.fields ?? {});
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(decodeValor);
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValor(v);
  return out;
}

function pad(label, size) {
  return String(label).padEnd(size, ' ');
}

async function probeUrl(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await fetch(url, { method: opts.method ?? 'GET', signal: ctrl.signal });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function lerFlagsEnvLocal() {
  try {
    const txt = fs.readFileSync('.env.local', 'utf8');
    const get = (chave) => {
      const m = txt.match(new RegExp(`^${chave}=(.*)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    return {
      NEXT_PUBLIC_USE_EMULATOR: get('NEXT_PUBLIC_USE_EMULATOR'),
      NEXO_USE_EMULATOR: get('NEXO_USE_EMULATOR'),
    };
  } catch {
    return {
      NEXT_PUBLIC_USE_EMULATOR: null,
      NEXO_USE_EMULATOR: null,
    };
  }
}

async function contarColecao(nome) {
  const snap = await db.collection(nome).count().get();
  return snap.data().count ?? 0;
}

async function maisRecente(nome, campo) {
  const snap = await db.collection(nome).orderBy(campo, 'desc').limit(1).get();
  if (snap.empty) return null;
  const valor = snap.docs[0].get(campo);
  if (!valor) return null;
  if (typeof valor?.toDate === 'function') return valor.toDate().toISOString();
  return typeof valor === 'string' ? valor : null;
}

async function resumoSyncState() {
  const snap = await db.collection('nexo_sync_state').get();
  const resumo = { ok: 0, degradado: 0, stale: 0, falha: 0, total: 0, comErro: 0 };
  for (const d of snap.docs) {
    const doc = d.data();
    resumo.total++;
    const status = String(doc.statusSaude ?? '');
    if (status === 'ok') resumo.ok++;
    else if (status === 'degradado') resumo.degradado++;
    else if (status === 'stale') resumo.stale++;
    else if (status === 'falha') resumo.falha++;
    if (doc.erro) resumo.comErro++;
  }
  return resumo;
}

function tempoRelativo(iso) {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'data inválida';
  if (ms < 60_000) return 'há instantes';
  if (ms < 3_600_000) return `há ${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `há ${Math.floor(ms / 3_600_000)} h`;
  return `há ${Math.floor(ms / 86_400_000)} dia(s)`;
}

async function main() {
  console.log('NEXO Local — diagnóstico');
  console.log(`Projeto: ${PROJECT_ID}`);
  console.log(`Bucket:  ${STORAGE_BUCKET}`);
  console.log('');

  const env = lerFlagsEnvLocal();
  console.log('Flags locais');
  console.log(`- NEXT_PUBLIC_USE_EMULATOR=${env.NEXT_PUBLIC_USE_EMULATOR ?? '(ausente)'}`);
  console.log(`- NEXO_USE_EMULATOR=${env.NEXO_USE_EMULATOR ?? '(ausente)'}`);
  console.log('');

  const servicos = [
    ['Next.js local', `http://${HOSTS.app}`],
    ['Auth Emulator', `http://${HOSTS.auth}`],
    ['Firestore Emulator', `http://${HOSTS.firestore}`],
    ['Functions Emulator', `http://${HOSTS.functions}`],
    ['Storage Emulator', `http://${HOSTS.storage}`],
  ];

  console.log('Portas e serviços');
  for (const [nome, url] of servicos) {
    const r = await probeUrl(url, { method: 'HEAD' });
    const detalhe = r.ok ? `HTTP ${r.status}` : r.erro;
    console.log(`- ${pad(nome, 20)} ${r.ok ? 'OK ' : 'OFF'} ${detalhe}`);
  }
  console.log('');

  console.log('Coleções monitoradas');
  for (const cfg of COLECOES) {
    try {
      const [count, recente] = await Promise.all([
        contarColecao(cfg.nome),
        maisRecente(cfg.nome, cfg.campoAtualizacao),
      ]);
      console.log(
        `- ${pad(cfg.nome, 24)} ${String(count).padStart(7)} docs  ${tempoRelativo(recente)}`,
      );
    } catch (err) {
      console.log(
        `- ${pad(cfg.nome, 24)} erro     ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  console.log('');

  try {
    const sync = await resumoSyncState();
    console.log('nexo_sync_state');
    console.log(
      `- total=${sync.total} ok=${sync.ok} degradado=${sync.degradado} stale=${sync.stale} falha=${sync.falha} docs-com-erro=${sync.comErro}`,
    );
  } catch (err) {
    console.log(
      `nexo_sync_state: erro ao resumir (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  console.log('');
  console.log('Dica');
  console.log('- Se algo estiver OFF, suba `npm run emu` e `npm run dev`, depois rode `npm run seed` se precisar reabastecer a base local.');
}

await main();
