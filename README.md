# NEXO — Sala de Situação (100% local)

NEXO é uma sala de situação de fiscalização municipal: ingere dados públicos
(Portal da Transparência, SICONFI, TCE-SP, PNCP, TSE, Diário Oficial etc.),
cruza entidades, detecta anomalias (fracionamento, superfaturamento, empresas
fantasma, sanções, conflitos de interesse...) e apresenta tudo em painéis —
Risco, Grafo, Dossiês, Perfis de fornecedor/pessoa, Investigações, entre
outros.

Este repositório é uma extração independente do NEXO a partir do
[oficioexpress](https://github.com/gabrieldias159/StudioOficioExpresso)
(onde ele nasceu como um módulo). Aqui ele roda **inteiramente local**, via
[Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) —
**sem nenhuma dependência de projeto Firebase em produção e sem custo de
nuvem**. Ideal para instalar em qualquer máquina própria e ter o NEXO rodando
de forma independente.

> Hoje o projeto Firebase usado (`studio-8612233125-caa0a`, ver
> `.firebaserc`/`src/firebase/config.ts`) é o de Marília — mas como tudo roda
> contra o **emulador**, isso só importa como um "nome de projeto local"; não
> é preciso ter acesso real a esse projeto para instalar e usar o NEXO.

## Arquitetura em uma frase

Next.js 15 App Router (`:9002`) + Firebase Emulators (auth `:9099`, firestore
`:8080`, functions `:5001`, storage `:9199`, pubsub `:8085`) + Cloud
Functions (`functions/`) com os crons de coleta/inteligência disparados por
um **scheduler local** (réplica do Cloud Scheduler, já que o emulador não
despacha `onSchedule` sozinho).

## Pré-requisitos

- **Node.js 22** (raiz e `functions/`)
- **JDK 11+** — o Firestore Emulator é Java. Se você não tiver um JDK no
  `PATH`, instale um (ex.: [Adoptium Temurin 21](https://adoptium.net/)) e
  aponte `JAVA_HOME` para ele. Detalhe importante: o Firebase CLI usa o
  `PATH`, não o `JAVA_HOME` — os scripts de arranque (`scripts/nexo-emu.cmd`,
  `scripts/nexo-local-startup.ps1`) já cuidam de prepender
  `%JAVA_HOME%\bin` ao `PATH` automaticamente se acharem um JDK em
  `%USERPROFILE%\.jdks\jdk-21...` ou `%USERPROFILE%\.jdks\jdk-17...`. Se o
  seu JDK estiver em outro lugar, ajuste `JAVA_HOME` manualmente antes de
  rodar, ou edite esses dois scripts.
- **Firebase CLI** — instalado como devDependency (`firebase-tools`), não
  precisa instalar globalmente.
- Windows é o ambiente testado (scripts `.cmd`/`.ps1`/`.vbs`); em
  Linux/macOS, use os comandos `firebase emulators:start` / `next dev`
  equivalentes diretamente (veja "Rodando sem os scripts .cmd" abaixo).

## Instalação

```bash
npm install
npm --prefix functions install
```

Copie `.env.local.example` para `.env.local` (já vem pronto no repo, mas se
recriar do zero: são só 2 flags, sem segredo nenhum).

## Como rodar (2-3 terminais)

1. **Emuladores Firebase** (auth + firestore + functions + storage + pubsub):
   ```
   npm run emu
   ```
   Compila e sobe os emuladores nas portas 9099/8080/5001/9199/8085 + UI em
   `:4000`. Na primeira vez, cria `.nexo-emu-data/` ao sair (`Ctrl+C`) — um
   snapshot dos dados locais que é reimportado no próximo arranque (sem isso,
   cada restart zera o Firestore local).

2. **Usuário de desenvolvimento** (uma vez, com os emuladores no ar):
   ```
   node scripts/nexo-seed-dev.mjs
   ```
   Cria/garante `dev@local.nexo` / `nexolocal123` no Auth emulator, com
   `role: admin` e `isActive: true`. Idempotente — pode rodar de novo a
   qualquer momento.

3. **Popular dados** (com os emuladores no ar):
   ```
   npm run seed
   ```
   Dispara o backfill HTTP contra o Functions emulator, abastecendo as
   coleções `nexo_*` com dados reais das fontes públicas (Portal da
   Transparência de Marília, SICONFI, TCE-SP, PNCP, TSE...). Aceita
   argumentos — veja o cabeçalho de `scripts/nexo-seed.mjs` para variações
   (por ano, por módulo, `--historico`, `--tce`, `--siconfi`).

   Depois do backfill bruto, rode os processadores de inteligência
   (linkage/perfil de entidades/score de risco) — são as próprias Cloud
   Functions (`onNexoLinkage`, `onNexoPerfilEntidades`, `onNexoScoreEntidades`)
   já expostas no emulador; dispare-as via `scripts/nexo-cron.mjs` (passo 4)
   ou manualmente pela Emulator UI (`:4000` → Functions).

4. **Scheduler local** (réplica do Cloud Scheduler — necessário porque o
   emulador NÃO despacha `onSchedule` sozinho):
   ```
   npm run cron
   ```
   Mantém rodando em background; dispara os crons de coleta/inteligência
   (`onNexoColetaDiaria`, `onNexoLinkage`, `onNexoPerfilEntidades`,
   `onNexoScoreEntidades`, `onNexoGerente`, `onNexoAdvogado`, etc.) via a
   rota "hub" do emulador de functions.

5. **Next.js dev server**:
   ```
   npm run dev
   ```
   Abre em `http://localhost:9002`. Login automático como `dev@local.nexo`
   (ver `src/firebase/local-auto-auth.tsx`) — não deveria nem passar pela
   tela de login.

### Arranque tudo-em-um

`scripts/nexo-local-startup.ps1` orquestra os passos acima (compila
functions → sobe emuladores em background, aguardando ficarem prontos →
garante o usuário dev → sobe o scheduler local → sobe o Next dev). Use
`npm run startup` para instalar como atalho no Menu Iniciar do Windows
(login automático da máquina), ou rode o `.ps1` diretamente:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/nexo-local-startup.ps1
```

Flags: `-NoSeed` (pula o seed do usuário dev), `-NoDev` (não sobe o Next),
`-ProdLocal` (builda e serve com `next start` em vez de `next dev`).

### Rodando sem os scripts `.cmd`/`.ps1` (Linux/macOS ou manual)

```bash
GCLOUD_PROJECT=studio-8612233125-caa0a \
DIARIO_BACKFILL_SECRET=nexo-local-emulator-secret-dev \
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
NEXO_USE_EMULATOR=1 \
firebase emulators:start --only auth,firestore,functions,storage,pubsub \
  --import .nexo-emu-data --export-on-exit .nexo-emu-data
```

Em outro terminal: `npm run dev`.

## Diagnóstico

```
npm run diag
```
Roda `scripts/nexo-local-check.mjs` — confere se os 5 emuladores + o Next
dev estão de pé e batendo, e reporta o estado básico das coleções `nexo_*`.

## Diretório do código

- `src/app/nexo/**` — páginas (App Router) da sala de situação.
- `src/app/api/nexo/**` — rotas server-side que os painéis consomem.
- `src/lib/nexo/**` — detectores de anomalia, normalização, cálculo de score,
  clientes das fontes (SICONFI/TCE/PNCP/TSE/...), schemas.
- `src/components/nexo/**` — shell, navegação, componentes de UI específicos.
- `functions/src/nexo/**` — Cloud Functions: crons de coleta por fonte,
  motor de linkage/cruzamento de entidades, score de risco, verticais
  GERENTE (monitoramento contínuo) e ADVOGADO (pareceres via IA), infra de
  jobs/snapshots.
- `functions/src/ia/config-uso.ts` — ponte de config + telemetria de uso da
  camada de IA multi-provider (`src/ai/*`), usada pelas verticais
  GERENTE/ADVOGADO.
- `scripts/nexo-*` — toda a ferramentaria de arranque/seed/diagnóstico local.
- `docs/nexo*`, `docs/nexo/*` — plano-mestre, catálogo de fontes/detectores,
  estado atual do pipeline local.

### Estúdio de Vídeo

Além da sala de situação, este repo traz o **Estúdio de Vídeo** do
oficioexpress — útil para montar os cortes/peças que saem das apurações sem
sair do ambiente local (e sem custo de nuvem, já que o render roda no ffmpeg
da própria máquina, via emulador de functions).

- `/apps/suite-editor-videos` — **avançado**: timeline multi-track, legendas
  (transcrição local via Whisper/`@huggingface/transformers`), transições,
  inspector, preview e render por tiers.
- `/apps/editor-videos` — **básico**: aplica logo e rodapé para padronização.
- `src/components/editor/**` + `src/lib/editor/**` — o editor em si.
- `src/app/api/video/import-url` — importa vídeo por URL (com fallback
  `youtubei.js`).
- `functions/src/video/**` — render/compressão/legendas/thumbnails.

Ambos abrem **fora do shell** do NEXO (são full-screen), e estão linkados no
menu lateral sob o grupo **Estúdio**.

> `onVideoCompressTranscoderRequest`/`onTranscoderPoll` falam com o Google
> Cloud Video Transcoder — serviço **pago e online**. Ficam no repo por
> paridade com a origem, mas não funcionam offline; para render local use os
> tiers `onRenderRequest*` (ffmpeg puro).

## O que NÃO veio nesta extração

- Dependência das demais áreas do oficioexpress (ofícios, Diário Oficial
  "interno", Acervo de Leis, SAPL...) — o NEXO já não dependia dessas áreas
  em runtime; só reaproveita rotinas genéricas compartilhadas
  (`src/firebase/*`, `src/components/ui/*`, `src/ai/*` — o gateway de IA
  multi-provider). O Estúdio de Vídeo é a exceção deliberada: veio junto, por
  pedido, e continua existindo também no repo de origem (os dois seguem
  caminhos independentes a partir daqui).
- Documentos de evidência da investigação fiscal (PDFs/imagens em
  `docs/fiscal-fontes/` no repo original, ~26 MB) — ficaram de fora por
  serem material de caso, não parte do produto. Copie manualmente se
  precisar deles aqui.
- Suíte de testes automatizados configurada: existem specs em
  `src/lib/nexo/__tests__/*.test.ts` (Node test runner nativo, `node:test`)
  copiados junto do código; rode com `npm test` (usa `tsx --test`). Não havia
  runner configurado no monorepo original — isso é novo aqui.
- Deploy para produção: este repo é para uso local. Se um dia quiser
  deployar de verdade (Firebase real, não emulador), vai precisar criar um
  projeto Firebase próprio, preencher `src/firebase/config.ts`/`.firebaserc`
  com as credenciais dele, e revisar `firestore.rules`/`storage.rules`
  (foram copiados do monorepo original e podem ter regras de coleções que
  não existem aqui).

## Estado do pipeline (última auditoria local)

Ver [`docs/nexo/estado-atual.md`](docs/nexo/estado-atual.md) para o
inventário mais recente do que funciona/não funciona rodando local (datas,
volumes de dados coletados, furos conhecidos).
