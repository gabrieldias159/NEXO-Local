# 🛰️ NEXO — HANDOFF da mega implementação (fim de semana autônomo)

**Branch:** `nexo/expansao` · **14 commits · 69 arquivos · +15,4K linhas** ·
**99 testes verdes · tsc root+functions limpo · NADA deployado/pushado.**

Plano completo em `docs/nexo-mega-fds.md`. Mapa de fontes em
`docs/nexo-mapa-prefeitura.md`.

## O que foi construído (todas as ondas)
| Onda | Entrega | Estado |
|---|---|---|
| **0** | Rede de segurança: 38→99 testes (`node:test`+`tsx`). A invariante-mãe pegou bug real (XS-07/FR-10 emitiam Prefeitura como fornecedor). RSS2_normas(503)→@@normas. Hash multiset. Hardening de crons. | ✅ |
| **1** | Qualidade da entidade (ente público fora de fornecedor) + 3ª perna do score + disclaimer. | ✅ |
| **2** | FR-04 (sancionado×empenho) ligado ponta-a-ponta. | ✅ |
| — | Fix OOM do `/api/nexo/detectar` (App Hosting 1→2 GB). Requerimento do dossiê no padrão do gabinete. | ✅ |
| **WF-2** | Catálogo `nexo_documentos` + coletores DOM/contratos/licitações/dispensas/TCE-despesas. | ✅ |
| **WF-3** | Motor de **linkage** (`nexo_links`) + divergência SMARAPD×TCE (X2) + **provas clicáveis**. | ✅ |
| **WF-7** | Base própria: **raio-x** (`nexo_entidades`) + `/api/nexo/busca` + detecção de **alteração retroativa**. | ✅ |
| **WF-4** | Crivo legal (`base-legal.ts`) + estatística robusta (mediana+MAD) + Benford (BN-01). | ✅ |
| **WF-5** | Crons de IA **gerente (30min)** + **advogado (1h)** (Genkit/Gemini). | ✅ |
| **WF-6** | UI 3 rounds: telas `/nexo/busca` (raio-x) e `/nexo/licitacoes` + provas em todo alerta. | ✅ |

## ✅ Checklist de DEPLOY (quando você aprovar — nesta ordem)
> App Hosting NÃO deploya functions/rules — são deploys SEPARADOS.

1. **Revisar** a branch `nexo/expansao` (diff vs `main`). Mergear quando ok.
2. **Functions** (novos crons): no diretório `functions/`,
   `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions`.
   Novos: `onNexoSyncTceDespesas, onNexoSyncContratos, onNexoSyncLicitacoes,
   onNexoColetaDom, onNexoLinkage, onNexoPerfilEntidades,
   onNexoDetectarAlteracoes, onNexoGerente, onNexoAdvogado`.
3. **Rules**: `firebase deploy --only firestore:rules` (a regex `nexo_*` já cobre
   as novas coleções — confirmar antes).
4. **App** (rotas + telas + fix OOM 2 GB): `git push` na main → App Hosting
   recria. Sobe `/api/nexo/{busca,gerente,advogado}` + telas `/nexo/{busca,licitacoes}`.

## ⚙️ Configuração que destrava dados
- **FR-04 (sanções):** setar `PORTAL_TRANSPARENCIA_TOKEN` (CGU, grátis) nas
  functions — sem ele `nexo_sancoes` fica "pendente de token" e o FR-04 não tem
  dado. *(É o que aparecia "Degradada" no painel.)*
- **Crons de IA (gerente/advogado):** dependem de `GEMINI_API_KEY` (já no
  `apphosting.yaml`). ⚠️ **Custo recorrente** (Gemini a cada 30min/1h) — decida
  se quer ligar já ou rarear a cadência.

## ⚠️ Caveats honestos (não-bloqueantes)
- **Não testado contra dados reais de prod** — validação foi por tsc + 99 testes
  unitários. Após deploy, conferir 1 ciclo de cada cron (logs + as coleções).
- **Coletores municipais:** `nomeContratada`/objeto às vezes vêm null no Dados
  Abertos → gancho de enriquecimento `portal/contrato/{id}` deixado p/ próxima onda.
- **Advogado:** a citação LOTCE-SP (LC 709/1993 art. 113) deve ser conferida
  contra a redação vigente antes de qualquer protocolo real.
- **Linkage de licitação↔CNPJ:** o Dados Abertos não expõe o vencedor na
  licitação; a associação plena depende do enriquecimento/grafo.

## Próximas ondas possíveis (quando você quiser)
Enriquecimento `portal/contrato/{id}` (nome+objeto+PDF); QSA/grafo societário
(cartel/laranja); rede-social do servidor (com cautela LGPD); netting líquido
(`tipoEmpenho`); índices Firestore compostos p/ serving em escala.
