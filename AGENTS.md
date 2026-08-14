# AGENTS.md — NEXO Local

Sala de situação de fiscalização municipal, rodando **100% local** no Firebase
Emulator Suite. **Custo ZERO** — nada toca Firebase de produção.

Extraído do [oficioexpress](https://github.com/gabrieldias159/StudioOficioExpresso),
onde nasceu como módulo. Lá ele não existe mais: não recriar `src/**/nexo/**`
no repo de origem.

## Quick Commands

```bash
npm run emu        # Terminal 1: emuladores (auth:9099, firestore:8080, functions:5001, storage:9199, pubsub:8085)
npm run dev        # Terminal 2: Next.js em localhost:9002
npm run seed       # Após emuladores prontos: abastece dados reais (backfill 2025-2026)
npm run cron       # Scheduler local (réplica do Cloud Scheduler)
npm run diag       # Diagnóstico do estado local
npm run typecheck  # tsc --noEmit (rodar antes de commitar)
npm run lint       # ESLint 9 (flat config)
npm test           # node:test via tsx, specs em src/lib/nexo/__tests__/
```

Cloud Functions (diretório `functions/`):
```bash
cd functions && npm run build   # compila TS → lib/
```

> **Node 22 é OBRIGATÓRIO.** O node 24 do host trava o import das functions
> (`Timeout after 10000`/503/502 no emulator). Usar o **node 22 portátil** em
> `%LOCALAPPDATA%\node22` (baixar com `scripts/baixar-node22.ps1`). Os launchers
> `nexo-emu.cmd`, `nexo-dev.cmd` e `nexo-local-startup.ps1` já prependem esse
> caminho ao PATH (auto-detect `node-v*`). Não instalar node 22 global: o
> requisito é só do emulador.

> **JDK 11+ obrigatório** para os emuladores de Firestore/Storage. Há um JDK 21
> em `C:\Users\Vereador\.jdks\jdk-21.0.11+10`. O `java` do PATH costuma ser o 8 —
> os launchers cuidam disso.

## Arquitetura

**Next.js 15 App Router** (`:9002`) + **Firebase Emulators** + **Cloud Functions**
com os crons disparados por um scheduler local.

| Diretório | Propósito |
|---|---|
| `src/app/nexo/**` | Páginas da sala de situação |
| `src/app/api/nexo/**` | Rotas server-side que os painéis consomem |
| `src/lib/nexo/**` | Detectores de anomalia, normalização, score, clientes das fontes, schemas |
| `src/lib/eleicoes/**` | Módulo Eleições (vive sob `/nexo/eleicoes`) |
| `src/components/nexo/**` | Shell, navegação, UI da sala |
| `src/components/editor/**`, `src/lib/editor/**` | Estúdio de Vídeo (ver abaixo) |
| `src/ai/**` | Gateway de IA multi-provider + flows |
| `functions/src/nexo/**` | Crons de coleta, linkage, score, verticais GERENTE/ADVOGADO, jobs |
| `functions/src/video/**` | Render/compressão/legendas/thumbnails do estúdio |
| `scripts/nexo-*` | Ferramentaria de arranque/seed/diagnóstico |
| `public/eleicoes/` | Fixtures do módulo Eleições (28 JSONs, versionados) |
| `public/{ffmpeg,models,transformers}/` | Assets vendorados do estúdio (~142 MB) |

**Path alias**: `@/*` → `./src/*`

## Pubsub e crons

O emulador de **pubsub (8085) é OBRIGATÓRIO**: sem ele o Functions Emulator
ignora as `onSchedule` (`function ignored because the pubsub emulator does not
exist`). Mesmo com ele, as scheduled functions só executam de verdade via
scheduler local (`npm run cron`) — no firebase-tools 13.35.1 o tópico
`firebase-schedule-<fn>` aceita o publish mas **não despacha**
(`Unsupported trigger signature: http`); por isso o daemon usa a rota de trigger
do hub.

## Arranque automático ao ligar o PC

```bash
npm run startup    # instala na pasta Startup do Windows (VBS silencioso)
```

Sobe emuladores + seed (se vazio) + Next.js + Chrome no NEXO. Para desativar,
apagar o atalho de `shell:startup`.

## Estúdio de Vídeo

Copiado do oficioexpress a pedido do dono — **existe nos dois repos e eles
divergem a partir daqui**; correção num não vai pro outro.

- `/apps/suite-editor-videos` — avançado: timeline multi-track, legendas com
  transcrição local (Whisper via `@huggingface/transformers`), transições,
  inspector, preview, render por tiers.
- `/apps/editor-videos` — básico: logo + rodapé.

Ambos abrem **fora do shell** do NEXO (são full-screen) e estão no menu sob o
grupo "Estúdio". Render roda no ffmpeg da própria máquina via emulador de
functions — custo zero.

> `onVideoCompressTranscoderRequest`/`onTranscoderPoll` falam com o Google Cloud
> Video Transcoder, serviço **pago e online**. Estão aqui por paridade com a
> origem mas **não funcionam offline** — para render local use os tiers
> `onRenderRequest*` (ffmpeg puro).

## Key Gotchas

1. **Os `.ps1`/`.cmd` têm de ser ASCII puro.** O PowerShell 5.1 lê UTF-8-sem-BOM como ANSI e acentos/travessões quebram o parser.
2. **Os docs usam `_exercicio`/`_fonte`** (com underscore) — é o que `lerColecaoNexo` filtra.
3. **`/api/nexo/orcamento` tem cache in-memory de 5 min**; depois de semear, "Sem execução coletada" persiste até o TTL expirar. O `/api/nexo/status` tem cache de 60s pelo mesmo motivo.
4. **SMARAPD não devolve tudo**: sem receita 2024/2025 nem despesa_sintetica 2024. Limitação da fonte, não bug.
5. **Gap entre fontes é esperado**: a despesa do portal SMARAPD é sistematicamente menor que o RREO/SICONFI consolidado (o portal não consolida autarquias/fundos). Cards usam SICONFI, gráfico usa SMARAPD com nota de fonte.
6. **Só `whisper-tiny` está vendorado** em `public/models`, embora o código referencie `whisper-base` como opção. Herdado da origem.
7. **Dados nunca inventados**: dado ausente vira "—" na UI, nunca número estimado sem rótulo. Regra dura do dono.
8. **Nada aqui deploya.** É repo de uso local. Para deployar de verdade seria preciso projeto Firebase próprio e revisão de `firestore.rules`/`storage.rules`.

## Convenções

- UI: ShadCN + Radix + Tailwind.
- Estado: Zustand. Validação: Zod.
- Server Actions envolvem os flows de IA — nunca chamar Genkit direto do client.
- Português em todo texto de usuário e nas mensagens de commit.
