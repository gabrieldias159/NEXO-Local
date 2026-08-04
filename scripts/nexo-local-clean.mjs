#!/usr/bin/env node

import { createRequire } from 'node:module';

const PROJECT_ID = 'studio-8612233125-caa0a';
const STORAGE_BUCKET = 'studio-8612233125-caa0a.firebasestorage.app';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const STORAGE_BASE = `http://${STORAGE_HOST}/v0/b/${STORAGE_BUCKET}/o`;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT_ID;
process.env.GCLOUD_PROJECT ||= PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST ||= FIRESTORE_HOST;

const require = createRequire(import.meta.url);
const { Firestore, FieldPath } = require('../functions/node_modules/@google-cloud/firestore');
const db = new Firestore({ projectId: PROJECT_ID });

const GRUPOS = {
  cache: ['nexo_tarefas', 'nexo_snapshots'],
  estado: ['nexo_sync_state'],
  derivados: [
    'nexo_alertas',
    'nexo_links',
    'nexo_entidades',
    'nexo_socios',
    'nexo_cruzamentos',
    'nexo_ranking_vinculo',
  ],
  dom: ['nexo_documentos', 'nexo_nomeacoes'],
};

function parseArgs(argv) {
  const out = {
    apply: false,
    groups: ['cache', 'estado', 'derivados'],
  };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg.startsWith('--groups=')) {
      out.groups = arg
        .slice('--groups='.length)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function assertLocalOnly() {
  const host = FIRESTORE_HOST.toLowerCase();
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
    throw new Error(
      `Recusa por segurança: FIRESTORE_EMULATOR_HOST=${FIRESTORE_HOST} não parece local.`,
    );
  }
}

async function contarColecao(nome) {
  const snap = await db.collection(nome).count().get();
  return snap.data().count ?? 0;
}

async function listarDocsColecao(nome) {
  const out = [];
  let ultimo = null;
  while (true) {
    let q = db.collection(nome).orderBy(FieldPath.documentId()).limit(300);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) out.push(doc.ref);
    ultimo = snap.docs[snap.docs.length - 1];
  }
  return out;
}

async function apagarColecao(nome) {
  const docs = await listarDocsColecao(nome);
  let batch = db.batch();
  let ops = 0;
  for (const ref of docs) {
    batch.delete(ref);
    ops++;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return docs.length;
}

async function limparStorageSnapshots() {
  try {
    const url = new URL(STORAGE_BASE);
    url.searchParams.set('prefix', 'nexo-snapshots/');
    const list = await fetch(url);
    if (!list.ok) throw new Error(`LIST HTTP ${list.status}`);
    const json = await list.json();
    const files = (json.items ?? []).map((item) => item.name).filter(Boolean);
    for (const name of files) {
      const res = await fetch(`${STORAGE_BASE}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DELETE HTTP ${res.status} (${name})`);
      }
    }
    return { ok: true, apagados: files.length };
  } catch (err) {
    return {
      ok: false,
      apagados: 0,
      erro: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolverColecoes(groups) {
  const selecionadas = new Set();
  for (const group of groups) {
    if (group === 'all') {
      for (const itens of Object.values(GRUPOS)) {
        for (const nome of itens) selecionadas.add(nome);
      }
      continue;
    }
    const itens = GRUPOS[group];
    if (!itens) throw new Error(`Grupo inválido: ${group}`);
    for (const nome of itens) selecionadas.add(nome);
  }
  return [...selecionadas];
}

function help() {
  console.log('NEXO Local — limpeza segura');
  console.log('');
  console.log('Uso:');
  console.log('  npm run clean:nexo');
  console.log('  npm run clean:nexo -- --groups=cache,derivados --apply');
  console.log('');
  console.log('Grupos:');
  console.log('  cache      nexo_tarefas, nexo_snapshots');
  console.log('  estado     nexo_sync_state');
  console.log('  derivados  nexo_alertas, nexo_links, nexo_entidades, nexo_socios, nexo_cruzamentos, nexo_ranking_vinculo');
  console.log('  dom        nexo_documentos, nexo_nomeacoes');
  console.log('  all        união de todos os grupos acima');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  assertLocalOnly();

  const colecoes = resolverColecoes(args.groups);
  console.log('NEXO Local — limpeza segura');
  console.log(`Firestore emulator: ${FIRESTORE_HOST}`);
  console.log(`Grupos: ${args.groups.join(', ')}`);
  console.log(`Modo: ${args.apply ? 'APLICAR' : 'DRY-RUN'}`);
  console.log('');

  const contagens = [];
  for (const nome of colecoes) {
    try {
      contagens.push({ nome, total: await contarColecao(nome) });
    } catch (err) {
      contagens.push({
        nome,
        total: -1,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const item of contagens) {
    if (item.total >= 0) console.log(`- ${item.nome}: ${item.total} docs`);
    else console.log(`- ${item.nome}: erro (${item.erro})`);
  }
  console.log('');
  console.log('Proteção');
  console.log('- Coleções brutas de ingestão não entram em nenhum grupo.');
  console.log('- Sem `--apply`, nada é apagado.');

  if (!args.apply) return;

  console.log('');
  console.log('Apagando...');
  for (const nome of colecoes) {
    const apagados = await apagarColecao(nome);
    console.log(`- ${nome}: ${apagados} docs apagados`);
  }

  if (colecoes.includes('nexo_snapshots')) {
    const storage = await limparStorageSnapshots();
    if (storage.ok) {
      console.log(`- storage:nexo-snapshots/: ${storage.apagados} objetos apagados`);
    } else {
      console.log(`- storage:nexo-snapshots/: falha (${storage.erro})`);
    }
  }
}

await main();
