# NEXO — Estado Atual, Consolidado (2026-08-03)

Consolidado do pipeline NEXO Local: arquitetura, arranque, dependências,
o que funciona, furos conhecidos e o ciclo de vida da informação. (viva à auditoria
`docs/auditoria-sistema.md` e `docs/revisao-geral-2026-06-02.md`.)

---

## 1. Arquitetura em uma frase

Next.js 15 App Router (`:9002`) + Firebase Emulators (auth `:9099`, firestore
`:8080`, functions `:5001`, storage `:9199`, pubsub `:8085`) + Cloud Functions
(`functions/`) com crons via **scheduler local** (réplica do Cloud Scheduler).

Cadeia de arranque (`npm run startup` → `nexo-local-startup.ps1`):
compile functions → start emulatador (com `--import`/`--export-on-exit` se
`.nexo-emu-data` existir) → `nexo-seed-dev.mjs` (dev user) → daemon
`nexo-cron.mjs` (dispara onSchedule via hub) → seed backfill → Next dev/prod.

## 2. Dependências (chaves)

- **Node 22** obrigatório (raiz e `functions/`).
- **firebase-tools 13.35.1** — o tópico `firebase-schedule-<fn>` aceita publish
  mas NÃO despacha scheduled functions; só o **hub** (`POST .../triggers/<key>`)
  funciona. Por isso `nexo-cron.mjs` usa a rota hub.
- **emulador pubsub `:8085` obrigatório** — sem ele as `onSchedule` são ignoradas.
- Emulador de Firestore é **in-memory**; `.nexo-emu-data` está VAZIO → restart
  sem export gracioso perde tudo (re-seedar via `npm run seed` / backfill).

## 3. O que FUNCIONA (validado ao vivo)

- Scheduler local: todos os `onSchedule` disparados com HTTP 200 e materialização real.
- Absorção de dados (ex.: <summary>): SMARAPD 32 módulos; TCE 45k empenhos/150k
  eventos; contratos 1.4k; licitações 1.3k; DOM; linkage ~106k vínculos; perfil
  3k entidades; score 1.5k; sócios cobertura ~91%; doações TSE 212k.
- Painéis: `/nexo/coleta` (absorção), `/nexo/saude-sistema` (health),
  `/nexo/saude-sistema` (ambient), **novo `/nexo/crons`** (agenda + estado).
- Login local auto-construtivo (dev user é criado sozinho no emulador).
- Login local: usuário `dev@local.nexo` (claims `role/admin` + `isActive:true`).

## 4. Furos / O que ainda NÃO funciona

1. **Sanções federais** (`onNexoSyncSancoes`) — `fetch failed` ~5min; precisa
   `PORTAL_TRANSPARENCIA_TOKEN` e fonte instável. ADIADO.
2. **`_registradoEm` (primeira observação)** — IMPLEMENTADO em `registro.ts`
   (TCE despesas/eventos), mas **só passa a valer no emulador após restart**
   (functions rebuildaram; emulador vivo carrega o build antigo).
3. **Persistência do emulador** — `.nexo-emu-data` vazio; restart sem export
   gracioso perde tudo. Extrapolar persistência robusta é pendente.
4. `onNexoBackfillTceDespesas` HTTP estava sem export em `index.ts` (usar
   `onNexoSyncTceDespesas` scheduled para TCE já cobre).
5. Cold start das functions é fl�pida: 1º disparo de um worker pode falhar
   ("Failed to handle request"); re-dispatch imediato funciona.

## 5. Ciclo de vida da informação (`_registradoEm`)

- `_coletadoEm` (serverTimestamp, merge) = **última observação** (sobrescrita).
- `_registradoEm` = **primeira observação** (set-once) — novo helper
  `carimbarPrimeiraObservacao` (`functions/src/nexo/registro.ts`) faz varredura
  paginada `where('_registradoEm','==',null)` e escreve `serverTimestamp()`.
- Aplicado em `nexo_tce_despesas` + `nexo_tce_despesas_eventos` (doc ID estável) —
  resolve o exemplo "pagamento de empenho sem data oficial → registrado hoje".
- **Caveat empenho SMARAPD**: docID embede hash de conteúdo → instável; a
  "primeira observação" ali precisa de agrupamento natural (`exercicio+nrEmpenho+
  cnpj`) — padrão já usado em `alteracao.ts`. (Pendência.)
- Onda relevante: `primeiroVisto` já existe em `nexo_snapshots` (3 coleções).

## 6. Novo: painel Cron & Processamento

- `src/lib/nexo/crons.ts` — catálogo estático da agenda (função, cron, área).
- `src/app/nexo/crons/page.tsx` — tabela por área (Coleta/Fontes/Inteligência/
  Verticais/Jobs) + semáforo real de `nexo_sync_state` (via `/api/nexo/saude-ingestao`).
- Nav: `/nexo/crons`.

## 7. Performance / usar local

- `npm run dev` = lento (compile on-demand). Uso no dia a dia → **prod-local**:
  `npm run build` + `npm run start:nexo-local` (sem hot-reload).
- `npm run startup:prod` instala auto-start prod-local; `npm run startup` dev.