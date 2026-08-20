# Estúdio de Vídeo — recursos do fluxo do gabinete

Origem: produção real do vídeo "Gusttavo Lima" (ago/2026), feita inteira em
ffmpeg por manifesto (`Downloads\VIDEO_GUSTAVO_LIMA\_manifesto.json` +
`_compilar.mjs` — ler ambos: são a referência de comportamento). Cada recurso
abaixo existiu na prática e economiza horas nos próximos vídeos. A skill
irmã no oficioexpress (`.claude/skills/video-gabinete/SKILL.md`) documenta as
regras editoriais; aqui é o que vira FEATURE com UI.

## P1 — implementar primeiro (maior alavanca)

### 1. Preset "Identidade do Gabinete" (1 clique)
Painel em Settings: logo (topo-direito, 44% da largura, some em fade ANTES da
vinheta), rodapé (97% W, embaixo, atravessa a vinheta e some em fade só no fim),
vinheta de encerramento (com `trim` da tela preta inicial configurável e
fade-in de 0,6 s no áudio dela — mata riser). Hoje `overlays{logo,footer,ending}`
já existe no `VideoProject`; falta: ordem Z acima de TUDO, regra "logo sai antes
da vinheta", rodapé sobre a vinheta, trim/audio-fade da vinheta.

### 2. Preset de legenda "Gabinete" + quebra em ≤5 palavras
Botão na CaptionTrack: aplica estilo (amarelo #FFFF00, Arial bold 27/478 de
largura equivalente, outline preto 3, MarginV 112, uppercase, WrapStyle "smart")
e REPARTE cada cue em pedaços de até 5 palavras com tempos proporcionais por
contagem de palavra. Tudo já existe em `CaptionCue/CaptionStyle`; é um comando
de transformação + um preset salvo.

### 3. Clip de TEXTO (palavra empilhável)
Novo tipo de clip "texto" (asset sintético): fonte Arial Black, cor, stroke,
sombra, tamanho auto pra caber (largura máx ~94% do palco), posição Y, animação
de entrada (fade/pop) e SOM acoplado opcional (biblioteca: Windows Critical
Stop, tum-tum, moedas...). Caso de uso: IPTU / CONTA DE LUZ / ITBI empilhando
com som de erro. Render: drawtext ou PNG gerado server-side (PIL/sharp).

### 4. Velocidade global do projeto (com remap automático)
Campo "velocidade da fala" (ex.: 1,14x): re-encoda a base (setpts+atempo) e
REMAPEIA a timeline inteira: clipes de imagem escalam ini/fim; vídeo/áudio
mantêm duração natural (só deslocam); legendas dividem por F. É exatamente o
algoritmo do `_prep_xfade.py`/remap do manifesto — portar.

### 5. Trilha nivelada + volume %
Na track de música: toggle "nivelar dinâmica" (dynaudnorm f=200 g=15 p=0.85)
+ volume em % (14–18% padrão) + fade-in/out automáticos. A voz nunca abaixa
(amix normalize=0 + limiter no master).

### 6. "Remover aperto de tela" (rabos) + transição nas junções
Na faixa base: por clipe, campo "cortar final (s)" com preview dos últimos
0,8 s em 3 thumbnails (é assim que se decide o corte), e xfade 0,3 automático
entre clipes consecutivos (vídeo + acrossfade de áudio).

## P2 — em seguida

### 7. Blur de fundo por janela
Efeito na base: boxblur=10 + brilho -6% entre t1..t2 (usado sob as palavras).

### 8. Preset chroma "fundo preto" (efeito_tela)
O `ClipChromaKey` já existe; adicionar preset 1-clique `lumakey` para arte em
fundo preto puro (chuva de R$ por cima do vereador) — threshold 0,05.

### 9. Biblioteca do gabinete no MediaBin
Aba fixa com: identidade (logo/rodapé/vinheta), sons aprovados (XP error, CC0),
memes próprios VM*, palavras/cards gerados. Fonte: pasta padrão no Storage.

### 10. Verificador pré-export
Checagens automáticas com aviso: flash de base <0,5 s entre overlays vizinhos;
legenda estourando largura; overlay maior que o palco; imagem colada no chat
não referenciada; duração final ≠ soma da base (nada pode alongar a fala).

## Regras de produto (das regras duras do dono)

- Overlay opaco tela cheia ≤3 s por padrão (a voz nunca é cortada).
- Export nunca alonga a fala: duração travada pela base.
- Vinheta nunca acelera com a velocidade global.
- Texto de valor sem documento → template já vem com "?" ("PODE CHEGAR A...").

## P3 — segunda leva (pedidos de 20/08, já validados no pipeline manual)

### 11. Voz na frente da música (mixagem)
Na trilha: highpass 130 Hz + equalizer -3,5 dB @2,8 kHz (abre espaço pro grave e
pra dicção da voz) + duck por sidechain com a voz de chave (threshold 0.02,
ratio 5, attack 25 ms, release 380 ms). Já implementado no compilar.mjs de
referência — portar pro export.

### 12. Legendas: fontes, animação e anticolisão
Seletor de fonte (Arial/Arial Black/Impact/Bahnschrift/Segoe UI), animação de
entrada (fade 100/60 ms; pop opcional) e validação dura: duas cues nunca no mesmo
milissegundo — editor encurta/empurra automaticamente e o verificador acusa.

### 13. Catálogo de sons (myinstants) sem download em massa
Painel de busca no catálogo (`ACERVO_GABINETE/sons/catalogo.json`), preview por
streaming e botão "trazer pro projeto" que baixa SÓ o som escolhido.

### 14. Acervo de memes/efeitos em vídeo
Aba no MediaBin espelhando `ACERVO_GABINETE/memes_video/` + fontes online
catalogadas (FONTES.md) com busca e download unitário.

## P4 — polimento de UI/UX (fluxo do gabinete de ponta a ponta)

### 15. Assistente "Novo vídeo do gabinete"
Botão na lista de projetos: cria projeto 9:16 30fps já com identidade ativada,
preset de legenda Gabinete, tracks nomeadas (V1 Féfin / V2 Criativos / V3 Memes /
A1 Efeitos / A2 Trilha) e a Biblioteca do gabinete aberta. Zero cliques de setup.

### 16. Biblioteca: arrastar pra timeline + pré-escuta
Drag & drop dos itens da Biblioteca do gabinete direto na track certa (som → A1,
meme → V3...). Sons com botão de pré-escuta no hover; vídeos com thumbnail animada.

### 17. Preview rápido de trecho
Selecionar um intervalo na régua e "renderizar só isso" em resolução baixa —
conferir um ajuste em segundos sem exportar o vídeo inteiro.

### 18. Alerta de flash na régua
Badge vermelho na timeline onde a base aparece por <0,5 s entre dois overlays
(a regra anti-"pisca" do dono). Clicou, playhead vai pro ponto. Complementa o
verificador do export, mas AO VIVO durante a edição.

### 19. Tooltips e rótulos pt-BR
Todos os recursos novos (velocidade, duck, aperto de tela, lumakey, blur) com
tooltip de 1 linha explicando o efeito prático. Nada de jargão em inglês solto.

### 20. Atalhos de edição
Conferir/completar: espaço play-pause, J/K/L, S = corte no playhead, setas =
frame a frame, Shift+setas = 1 s, Del = remover clip selecionado.
