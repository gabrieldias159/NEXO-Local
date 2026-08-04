#!/usr/bin/env node

/**
 * NEXO Local — Seed dos dados.
 *
 * Dispara o backfill HTTP contra o Functions Emulator para abastecer
 * as colecoes nexo_* com dados reais do Portal da Transparencia.
 *
 * Uso:
 *   node scripts/nexo-seed.mjs                      # seed padrao (2025-2026, todos)
 *   node scripts/nexo-seed.mjs 2025,2026             # anos especificos
 *   node scripts/nexo-seed.mjs 2025,2026 empenhos,diarias  # anos + modulos
 *   node scripts/nexo-seed.mjs --historico           # TCE-eventos 2014+ + SICONFI 2013+
 *   node scripts/nexo-seed.mjs 2014,2015 --tce       # backfill TCE-despesas especifico
 *   node scripts/nexo-seed.mjs 2013,2014 --siconfi   # backfill SICONFI especifico
 */

const BACKFILL_SECRET = process.env.DIARIO_BACKFILL_SECRET || 'nexo-local-emulator-secret-dev';
const EMULATOR_HOST = process.env.EMULATOR_HOST || 'http://127.0.0.1:5001';
const PROJECT = 'studio-8612233125-caa0a';
const REGION = 'us-central1';

const argv = process.argv.slice(2);
const flgTce = argv.includes('--tce');
const flgSiconfi = argv.includes('--siconfi');
const flgHistorico = argv.includes('--historico');
const args = argv.filter((a) => !a.startsWith('--'));

let anos = args[0] || '2025,2026';
const modulos = args[1] || 'all';

async function disparar(endpoint, params) {
  const url = `${EMULATOR_HOST}/${PROJECT}/${REGION}/${endpoint}?${params}`;
  console.log(`  ${endpoint}`);
  const res = await fetch(url, { headers: { 'x-backfill-secret': BACKFILL_SECRET } });
  const data = await res.json();
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} — ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  if (flgHistorico) {
    console.log(`[NEXO Seed] Backfill HISTORICO:`);
    console.log(`  TCE-SP despesas por evento (2014..2025) — coleta demorada (por ano)`);
    console.log(`  SICONFI RREO/RGF (2013..2025) — ~9 demonstrativos/ano`);
    console.log(``);
    const anosTce = Array.from({ length: 2025 - 2014 + 1 }, (_, i) => 2014 + i).join(',');
    const anosSiconfi = Array.from({ length: 2025 - 2013 + 1 }, (_, i) => 2013 + i).join(',');
    // O emulador roda sincronamente; backfills longos podem estourar o timeout
    // HTTP do cliente — chamamos em sequencia e reportamos o que deu certo.
    try {
      const rTce = await disparar('onNexoBackfillTceDespesas', `anos=${anosTce}`);
      console.log(`[NEXO Seed] TCE-despesas: ${rTce.exercicios} exercicios, ${rTce.comErro} com erro`);
    } catch (e) { console.error(`[NEXO Seed] ERRO TCE-despesas: ${e.message}`); }
    try {
      const rSic = await disparar('onNexoBackfillSiconfi', `anos=${anosSiconfi}`);
      console.log(`[NEXO Seed] SICONFI: ${rSic.exercicios} exercicios, ${rSic.periodosComFalha} periodos com falha`);
    } catch (e) { console.error(`[NEXO Seed] ERRO SICONFI: ${e.message}`); }
    console.log(``);
    console.log(`[NEXO Seed] Dica: rode depois o seed SMARAPD padrao (npm run seed) para 2025-2026.`);
    return;
  }

  if (flgTce) {
    const data = await disparar('onNexoBackfillTceDespesas', `anos=${anos}`);
    console.log(`[NEXO Seed] TCE-despesas concluido: ${data.exercicios} exercicios, ${data.comErro} com erro`);
    for (const r of data.resultados) {
      if (r.erro) console.error(`  ERRO [${r.ano}]: ${r.erro}`);
    }
    return;
  }

  if (flgSiconfi) {
    const data = await disparar('onNexoBackfillSiconfi', `anos=${anos}`);
    console.log(`[NEXO Seed] SICONFI concluido: ${data.exercicios} exercicios, ${data.periodosComFalha} periodos com falha`);
    return;
  }

  const data = await disparar('onNexoBackfillHttp', `anos=${anos}&modulos=${modulos}`);
  console.log(`[NEXO Seed] Concluido! ${data.ingestoes} ingestões, ${data.comErro} com erro`);
  if (data.comErro > 0) {
    for (const r of data.resultados) {
      if (r.erro) console.error(`  ERRO [${r.modulo}/${r.exercicio}]: ${r.erro}`);
    }
  }
}

main().catch((err) => {
  console.error(`[NEXO Seed] Falha: ${err.message}`);
  console.log(`\nO emulador de functions esta rodando? Execute "scripts\\nexo-emu.cmd" primeiro.`);
  process.exit(1);
});
