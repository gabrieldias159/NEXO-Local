# API de automação do Estúdio de Vídeo

Permite montar um projeto de vídeo por HTTP — criar, jogar a mídia base, fazer
recortes, empilhar criativos, aplicar efeitos, gerar legendas e mandar
renderizar — **sem tocar na interface**. Foi feita para um agente (Claude)
operar o Estúdio, mas serve para qualquer script.

O que a API monta é o **mesmo documento** que a interface monta. Um projeto
criado por aqui abre no editor normalmente, com timeline, clips e legendas no
lugar; e um projeto criado na interface pode ser editado por aqui.

---

## Antes de começar

**Só funciona contra o emulador.** As rotas escrevem no Firestore com
privilégio de `owner`, ignorando as security rules. Se `NEXO_USE_EMULATOR`
não estiver ligado, toda chamada falha com mensagem explícita. É deliberado:
uma API que escreve sem rules não pode alcançar um Firebase real.

**Autenticação:** header `x-internal-ia-token`, com o valor de
`INTERNAL_IA_TOKEN` (o mesmo do gateway de IA, definido em `.env.local`).
Sem ele, `401`.

```bash
curl -H "x-internal-ia-token: $INTERNAL_IA_TOKEN" \
     http://localhost:9002/api/editor/projects
```

**Pré-requisitos:** emuladores no ar (`npm run emu`) e app no ar (`npm run dev`).

---

## Endpoints

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/editor/projects` | lista os projetos |
| `POST` | `/api/editor/projects` | cria um projeto |
| `GET` | `/api/editor/projects/{id}` | estado completo do projeto |
| `GET` | `/api/editor/projects/{id}?resumo=1` | só o mapa da timeline |
| `DELETE` | `/api/editor/projects/{id}` | apaga o projeto |
| `GET` | `/api/editor/projects/{id}/ops` | catálogo de operações |
| `POST` | `/api/editor/projects/{id}/ops` | **aplica operações em lote** |
| `POST` | `/api/editor/projects/{id}/render` | enfileira o render |
| `GET` | `/api/editor/projects/{id}/render` | status dos renders |

### Criar projeto

```json
POST /api/editor/projects
{ "nome": "Rodeio — corte para redes", "resolucao": "vertical", "frameRate": 30 }
```

Resoluções: `1080p`, `720p`, `vertical` (9:16 720p), `vertical-1080`,
`quadrado`, `4:5`. `frameRate`: 24, 30 ou 60.

A resposta traz `id` e `abrirEm` — o caminho para abrir no editor.

### Ler o estado

`?resumo=1` é o que você quer na maior parte do tempo: devolve assets, tracks e
os tempos de cada clip, sem trafegar o projeto inteiro.

```json
{
  "id": "proj_...", "nome": "...", "duracao": 18,
  "assets": [{ "id": "asset_...", "nome": "Base", "tipo": "video", "duracao": 30 }],
  "tracks": [{
    "id": "track_...", "tipo": "video", "nome": "Principal",
    "clips": [{ "id": "clip_...", "naTimeline": [0, 6], "naMidia": [2, 8] }]
  }],
  "legendas": [{ "id": "cap_...", "nome": "Locucao", "falas": 2 }]
}
```

---

## Operações (`/ops`)

O endpoint principal. Manda uma **lista** e ela é aplicada em ordem:

```json
POST /api/editor/projects/{id}/ops
{ "ops": [ { "op": "addAsset", ... }, { "op": "addClip", ... } ] }
```

**Tudo ou nada.** Se qualquer operação falhar, nenhuma é gravada e a resposta é
`422` com a mensagem do que deu errado e o índice da operação culpada. O projeto
nunca fica meio-editado. `422` = payload errado (corrija e repita);
`500` = falha de infraestrutura.

A resposta devolve os **ids criados**, na ordem, para você encadear:

```json
{ "ok": true, "aplicadas": 2, "duracao": 18,
  "resultados": [ {"op":"addAsset","ok":true,"id":"asset_..."},
                  {"op":"addClip","ok":true,"id":"clip_..."} ] }
```

### `addAsset` — põe mídia no acervo

```json
{ "op": "addAsset", "url": "https://…/base.mp4", "tipo": "video",
  "nome": "Base", "duracao": 30 }
```

`tipo`: `video` | `image` | `audio`. **Não faz upload** — a URL já tem de estar
acessível. Informe `duracao` para vídeo/áudio: sem ela, o `addClip` que omitir
`fimNaMidia` assume 5s. Para um arquivo que já está no Storage, passe também
`storagePath`.

### `addTrack` — cria uma faixa

```json
{ "op": "addTrack", "tipo": "video", "nome": "Principal" }
```

### `addClip` — **é o recorte**

Põe um trecho da mídia na timeline.

```json
{ "op": "addClip", "assetId": "asset_...", "trackId": "track_...",
  "inicioNaMidia": 2, "fimNaMidia": 12 }
```

- `inicioNaMidia` / `fimNaMidia` — recortam a **fonte** (em segundos).
- `inicioNaTimeline` — onde o trecho entra. **Omita** e o clip é anexado ao fim
  do que já existe na track: é assim que se monta uma sequência.
- Opcionais: `velocidade` (0.25–4), `slot` (`full`/`top`/`bottom`),
  `layer` (0 = base; maior fica por cima), `fit` (`contain`/`cover`).

### `splitClip` — corta em dois

```json
{ "op": "splitClip", "clipId": "clip_...", "emSegundos": 6 }
```

O tempo é o da **timeline** e precisa cair dentro do clip. O ponto
correspondente na mídia é calculado proporcionalmente (respeitando a
velocidade). Devolve o id da metade da direita.

### `updateClip` — tempos e efeitos

```json
{ "op": "updateClip", "clipId": "clip_...", "patch": {
    "filtros": { "brightness": 1.2, "saturation": 1.3 },
    "transform": { "scale": 1.08, "x": 0.1 },
    "audio": { "volume": 0.3, "fadeOutDuration": 2 },
    "velocidade": 1.5
}}
```

Os blocos `filtros`, `transform`, `audio` e `chromaKey` são **mesclados**, não
substituídos — mande só o que muda.

- `filtros`: `brightness`, `contrast`, `saturation` (1 = neutro), `blur`,
  `hue`, `grayscale`.
- `transform`: `x`, `y` (−1 a 1, relativos ao centro), `scale`, `rotation`,
  `opacity`, `flipH`, `flipV`.
- `audio`: `volume`, `muted`, `pan`, `fadeInDuration`, `fadeOutDuration`.
- Tempos: `inicioNaTimeline`, `fimNaTimeline`, `inicioNaMidia`, `fimNaMidia`.

### `setTransition`

```json
{ "op": "setTransition", "clipId": "clip_...", "onde": "in",
  "tipo": "fade", "duracao": 0.5 }
```

### `setCaptions` — legendas

```json
{ "op": "setCaptions", "nome": "Locucao", "idioma": "pt-BR", "cues": [
    { "inicio": 0, "fim": 3, "texto": "Primeira fala." },
    { "inicio": 3, "fim": 6.5, "texto": "Segunda fala." }
]}
```

Substitui a faixa inteira. Para gerar as falas a partir do áudio, use antes o
gateway de IA (`POST /api/ia/transcrever`, que responde por Groq Whisper com
timestamps) e alimente os `cues` com o resultado.

### Outras

`setProject` (nome, resolução, fps, `stageMode`, `stageBackground`, `overlays`),
`removeClip`, `removeTrack`, `removeAsset`.

---

## Render

```json
POST /api/editor/projects/{id}/render
{ "resolucao": "720p", "formato": "mp4", "qualidade": "high",
  "queimarLegendas": true }
```

Responde `202` com o `jobId`. O render **não** acontece na rota: grava um doc em
`renderJobs/{jobId}` e a Cloud Function `onRenderRequest{Low,Medium,High}` reage
ao trigger e roda o ffmpeg — localmente, no emulador de functions, custo zero.

Sempre usa `engine: cloud-ffmpeg`: o caminho `ffmpeg-wasm` roda **no navegador**,
e aqui não há navegador.

Acompanhe com `GET /api/editor/projects/{id}/render` até `status: complete`;
aí `urlSaida` traz o arquivo. Um projeto sem nenhum clip é recusado com `422`.

---

## Exemplo completo

Monta um corte vertical com duas cenas, corte no meio, efeito, transição,
trilha e legendas:

```bash
T="$INTERNAL_IA_TOKEN"; B=http://localhost:9002
H=(-H "Content-Type: application/json" -H "x-internal-ia-token: $T")

# 1. projeto
PID=$(curl -s "${H[@]}" -X POST $B/api/editor/projects \
  -d '{"nome":"Rodeio","resolucao":"vertical","frameRate":30}' | jq -r .id)

# 2. acervo + trilhas  (guarde os ids devolvidos)
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/ops -d '{"ops":[
  {"op":"addAsset","url":"https://…/base.mp4","tipo":"video","nome":"Base","duracao":30},
  {"op":"addAsset","url":"https://…/trilha.mp3","tipo":"audio","nome":"Trilha","duracao":60},
  {"op":"addTrack","tipo":"video","nome":"Principal"},
  {"op":"addTrack","tipo":"audio","nome":"Trilha"}
]}'

# 3. recortes, corte, efeito, legendas  (use os ids do passo 2)
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/ops -d '{"ops":[
  {"op":"addClip","assetId":"asset_A","trackId":"track_V","inicioNaMidia":2,"fimNaMidia":12},
  {"op":"addClip","assetId":"asset_A","trackId":"track_V","inicioNaMidia":20,"fimNaMidia":28},
  {"op":"addClip","assetId":"asset_B","trackId":"track_A","inicioNaMidia":0,"fimNaMidia":18,"inicioNaTimeline":0},
  {"op":"splitClip","clipId":"clip_1","emSegundos":6},
  {"op":"updateClip","clipId":"clip_2","patch":{"filtros":{"brightness":1.2},"velocidade":1.5}},
  {"op":"setTransition","clipId":"clip_2","onde":"in","tipo":"fade","duracao":0.5},
  {"op":"setCaptions","nome":"Locucao","cues":[
    {"inicio":0,"fim":3,"texto":"Primeira fala."},
    {"inicio":3,"fim":6.5,"texto":"Segunda fala."}]}
]}'

# 4. renderizar
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/render \
  -d '{"resolucao":"720p","formato":"mp4","queimarLegendas":true}'
```

Abra o resultado em `http://localhost:9002/apps/suite-editor-videos/$PID`.

---

## Notas de implementação

- `src/lib/editor/api/ops.ts` — motor de operações (funções puras).
  Os defaults de `transform`/`filters`/`audio`/estilo de legenda **espelham
  `src/lib/editor/store.ts`**. Se mudarem lá, mude aqui: um clip criado pela API
  tem de ser indistinguível de um criado na interface.
- `src/lib/editor/api/firestore-rest.ts` — acesso ao Firestore por REST com
  `Bearer owner` (o app não carrega o Admin SDK, por regra do repo).
- `src/lib/editor/api/owner.ts` — resolve o `ownerUid` pelo e-mail do usuário
  local. As rules de `videoProjects` exigem `ownerUid == request.auth.uid` para
  leitura: se o dono gravado divergir, o projeto existe mas some da interface.
- Campos obrigatórios fáceis de esquecer: `CaptionTrack` precisa de `index` e
  `locked`; cada `CaptionCue` precisa de `slot` e `style` — o preview lê
  `cue.style.position` direto e quebra se faltar.
