---
name: estudio-video
description: |
  Use esta skill para MONTAR ou EDITAR um vídeo no Estúdio do NEXO-Local por
  HTTP, sem tocar na interface: criar projeto, carregar a mídia base do disco,
  fazer recortes, empilhar criativos, aplicar efeitos, gerar legendas e mandar
  renderizar.

  Gatilhos:
  - "monta um vídeo", "faz um corte", "edita esse vídeo", "põe legenda"
  - "corta de X a Y", "junta esses clipes", "acelera esse trecho"
  - "carrega esse mp4 no editor", "joga esse vídeo no projeto"
  - "renderiza", "exporta o vídeo"
  - o usuário manda um caminho de arquivo de vídeo/áudio/imagem e pede edição

  NÃO use para: mexer no código do editor (isso é edição normal de código) nem
  para vídeo em produção (esta API só opera contra o emulador local).
---

# Estúdio de Vídeo — montar por API

Monta projetos de vídeo no NEXO-Local por HTTP. O que a API monta é o **mesmo
documento** que a interface monta: o resultado abre no editor normalmente, com
timeline, mídia e legendas no lugar.

Documentação completa da API: `docs/estudio-api.md`.

## Antes de qualquer coisa: checar se está no ar

```bash
for p in 9002 8080 9199; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 \
  && echo "$p OK" || echo "$p CAIU"; done
```

Se caiu, subir (na pasta `NEXO-Local`):

```bash
export JAVA_HOME="$HOME/.jdks/jdk-21.0.11+10"
export PATH="$LOCALAPPDATA/node22/node-v22.23.2-win-x64:$JAVA_HOME/bin:$PATH"
export FUNCTIONS_DISCOVERY_TIMEOUT=120 GCLOUD_PROJECT=studio-8612233125-caa0a
export PUBSUB_EMULATOR_HOST=127.0.0.1:8085 NEXO_USE_EMULATOR=1
./node_modules/.bin/firebase emulators:start \
  --only auth,firestore,functions,storage,pubsub --import .nexo-emu-data &
./node_modules/.bin/next dev -p 9002 &
node scripts/nexo-seed-dev.mjs      # SEM isto, tudo volta 403
```

`FUNCTIONS_DISCOVERY_TIMEOUT=120` e o `seed-dev` **não são opcionais** — ver
"Armadilhas" no fim.

## Autenticação

Header `x-internal-ia-token` com o valor de `INTERNAL_IA_TOKEN` do `.env.local`.

```bash
T=$(grep '^INTERNAL_IA_TOKEN=' .env.local | cut -d= -f2)
H=(-H "Content-Type: application/json" -H "x-internal-ia-token: $T")
B=http://localhost:9002
```

## O fluxo, na ordem

### 1. Criar o projeto

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects \
  -d '{"nome":"Corte para redes","resolucao":"vertical","frameRate":30}'
```

Resoluções: `vertical` (9:16 720p), `vertical-1080`, `1080p`, `720p`,
`quadrado`, `4:5`. Guarde o `id` devolvido.

### 2. Carregar a mídia DO DISCO

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/midia \
  -d '{"caminho":"C:/Users/Vereador/Videos/bruto.mp4","nome":"Base"}'
```

Sobe para o Storage do emulador e mede duração e dimensões com ffmpeg.
**Sempre use este endpoint para arquivo local** — o `addAsset` das operações só
aceita URL já acessível, e um arquivo no disco não é uma URL.

A resposta traz `assetId` e `duracao`. Anote os dois: a duração é o que permite
escolher os tempos de recorte com precisão.

### 3. Criar as faixas

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/ops -d '{"ops":[
  {"op":"addTrack","tipo":"video","nome":"Principal"},
  {"op":"addTrack","tipo":"audio","nome":"Trilha"}
]}'
```

Os ids voltam em `resultados`, na mesma ordem das operações.

### 4. Recortar e montar

`addClip` **é o recorte**. `inicioNaMidia`/`fimNaMidia` cortam a fonte;
omitir `inicioNaTimeline` emenda o clip no fim do que já existe na faixa —
é assim que se monta uma sequência.

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/ops -d '{"ops":[
  {"op":"addClip","assetId":"asset_X","trackId":"track_V","inicioNaMidia":2,"fimNaMidia":8},
  {"op":"addClip","assetId":"asset_X","trackId":"track_V","inicioNaMidia":14,"fimNaMidia":19},
  {"op":"splitClip","clipId":"clip_1","emSegundos":4},
  {"op":"updateClip","clipId":"clip_2","patch":{
     "filtros":{"brightness":1.2,"saturation":1.3},"velocidade":1.5}},
  {"op":"setTransition","clipId":"clip_2","onde":"in","tipo":"fade","duracao":0.5}
]}'
```

Operações: `setProject`, `addAsset`, `removeAsset`, `addTrack`, `removeTrack`,
`addClip`, `updateClip`, `removeClip`, `splitClip`, `setTransition`,
`setCaptions`.

Blocos `filtros`/`transform`/`audio`/`chromaKey` são **mesclados** — mande só
o que muda.

### 5. Legendas

Com texto pronto:

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/ops -d '{"ops":[
  {"op":"setCaptions","nome":"Locucao","cues":[
    {"inicio":0,"fim":3,"texto":"Primeira fala."},
    {"inicio":3,"fim":6.5,"texto":"Segunda fala."}]}
]}'
```

Para transcrever o áudio automaticamente, chame antes o gateway de IA — ele
responde por **Groq Whisper** com timestamps, que é exatamente o formato dos
cues:

```bash
curl -s "${H[@]}" -X POST $B/api/ia/transcrever \
  -d '{"audioDataUri":"data:audio/wav;base64,…","idioma":"pt"}'
```

### 6. Conferir antes de renderizar

```bash
curl -s "${H[@]}" "$B/api/editor/projects/$PID?resumo=1"
```

Devolve o mapa da timeline (tempos de cada clip) sem trafegar o projeto todo.
**Sempre confira aqui** antes de dizer ao usuário que está pronto.

### 7. Renderizar

```bash
curl -s "${H[@]}" -X POST $B/api/editor/projects/$PID/render \
  -d '{"resolucao":"720p","formato":"mp4","queimarLegendas":true}'
# acompanhar:
curl -s "${H[@]}" $B/api/editor/projects/$PID/render
```

Grava em `renderJobs` e a function `onRenderRequest*` roda o ffmpeg no emulador
— local, custo zero. Acompanhe até `status: complete`; aí `urlSaida` traz o
arquivo.

### 8. Entregar o link

```
http://localhost:9002/apps/suite-editor-videos/$PID
```

## Borrar rostos de terceiros

Material que vai a documento público e mostra gente que não é objeto da peça —
crianças em escola, servidores, transeuntes — precisa ter os rostos borrados.

Na exportação existe o botão **Borrar rostos**. Ligando, aparece o campo
"Preservar quem aparece aos … segundos": informe um instante em que a pessoa que
**deve continuar identificável** apareça de frente e bem enquadrada (o agente
público, em regra). Vazio = borra todos.

Fora do editor, a mesma coisa pela linha de comando, e aí também serve para
imagem (print de rede social, foto de anexo):

```bash
python tools/borrar-rostos/borrar_rostos.py entrada.mp4 --relatorio --preservar-rosto-em 20
```

**Sempre rode `--relatorio` antes.** Ele lista as trilhas e o que pretende fazer
com cada uma, sem gravar nada. É onde se vê se a pessoa certa foi preservada.

Detalhes e ajustes finos: `tools/borrar-rostos/README.md`.

**Ao publicar, declare a intervenção** no documento — que os rostos foram
borrados, quem foi preservado e que nada mais mudou — e guarde o original. Sem
isso a peça fica exposta à alegação de vídeo adulterado.

## Armadilhas (todas já custaram tempo)

1. **403 em tudo / "evaluation error at L255"** → o perfil `users/{uid}` sumiu.
   Toda vez que o emulador reimporta, o usuário nasce com uid novo. Rode
   `node scripts/nexo-seed-dev.mjs`. É a primeira coisa a tentar.

2. **"Não foi possível abrir" com `Null value error`** → a URL aponta para um
   projeto que não existe mais. Não é permissão. Liste os projetos e use um id
   válido.

3. **Nenhuma function carrega (`Timeout after 10000`)** → falta
   `FUNCTIONS_DISCOVERY_TIMEOUT=120` no `emulators:start`. Sem isso o render
   nunca roda. O código está são; é a descoberta do emulador no Windows.

4. **Mídia não carrega no editor** → o asset provavelmente tem URL que não
   existe. Use o endpoint `/midia` (passo 2), que sobe o arquivo de verdade e
   gera URL com token. URL inventada entra no projeto sem erro e só falha na
   hora de tocar.

5. **Nunca invente tempos.** Pegue a `duracao` real devolvida pelo `/midia`.
   Um `addClip` sem `fimNaMidia` num asset sem duração cai no default de 5s e o
   recorte sai errado em silêncio.

6. **A API só funciona contra o emulador**, de propósito: escreve com privilégio
   de `owner`, ignorando as security rules. Existe uma validação que recusa
   gravar projeto sem `ownerUid`/`updatedAt` — sem ela dava para criar um
   projeto que a interface não lista, porque a lista é
   `where('ownerUid'...) + orderBy('updatedAt')`.

**Borrão de rostos decidido quadro a quadro vira lixo.** O detector acha "rosto"
em parede e cortina; quadro a quadro cada erro vira um borrão que pisca. E o
reconhecimento facial perde a pessoa quando ela fica pequena ou de perfil — a
ponto de um terceiro pontuar mais que ela e o resultado inverter. A ferramenta já
resolve isso decidindo por trilha, mas se você mexer nos parâmetros, é esse o
comportamento que volta a aparecer.

## Verificar de verdade

Não afirme que funcionou só porque a API respondeu 200 — ela usa um caminho
privilegiado que **ignora as rules que a interface obedece**. Confirme pelo
caminho do usuário:

```bash
# a lista da interface mostra o projeto?
curl -s "${H[@]}" $B/api/editor/projects
```

E, quando importar, cheque no navegador que o `<video>` chegou a
`readyState: 4` — é a diferença entre "o clip está na timeline" e "o vídeo
toca".
