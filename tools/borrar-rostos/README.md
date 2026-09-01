# Borrar rostos

Ferramenta para publicar material do gabinete sem expor a imagem de terceiros —
tipicamente crianças em unidade escolar — mantendo identificável quem é objeto do
documento.

Roda sozinha, pela linha de comando, e também é chamada pelo renderizador do
estúdio de vídeo quando a exportação pede "borrar rostos".

## Instalação

```bash
pip install opencv-python numpy
node scripts/nexo-baixar-modelos-rosto.mjs
```

Os modelos (39 MB) ficam em `modelos/` e **não vão para o git**. Sem eles a
ferramenta avisa e sai; o renderizador apenas pula o borrão e segue.

## Uso

```bash
# borra todos os rostos
python borrar_rostos.py entrada.mp4 saida.mp4

# borra todos, menos quem aparece aos 20 segundos do próprio vídeo
python borrar_rostos.py entrada.mp4 saida.mp4 --preservar-rosto-em 20

# borra todos, menos quem estiver neste retrato
python borrar_rostos.py entrada.mp4 saida.mp4 --preservar retrato.jpg

# funciona em imagem também (print de rede social, foto de anexo)
python borrar_rostos.py print.png saida.png --preservar retrato.jpg
```

## Confira antes de gravar

`--relatorio` lista o que a ferramenta pretende fazer e **não escreve nada**:

```bash
python borrar_rostos.py entrada.mp4 --relatorio --preservar-rosto-em 20
```

```
trilhas solidas: 7 | descartadas como ruido: 16
    0.0s..  5.5s   159 det  nota 0.15  borrado
    5.2s.. 17.7s   370 det  nota 0.68  preservado
    6.8s.. 16.8s   295 det  nota 0.27  borrado
```

Use sempre. É aqui que se vê se a pessoa certa foi preservada e se sobrou trilha
estranha. `--json` dá a mesma coisa para consumo programático.

## Por que é feito por trilha, e não quadro a quadro

A versão óbvia — detecta rosto em cada quadro, borra — produz lixo, por dois
motivos que se corrigem do mesmo jeito.

**Falso positivo.** O detector acha "rosto" em parede, cortina e cartaz. Quadro a
quadro, cada erro vira um borrão que pisca e some. Ligando as detecções em
trilhas, dá para exigir que a trilha dure: rosto de verdade permanece, falso
positivo pisca. No vídeo de teste isso descartou 16 de 23 trilhas.

**Reconhecimento instável.** Identificar quem preservar só funciona bem com rosto
grande e frontal. Num trecho do vídeo de teste o rosto a preservar ficou com
36×63 pixels e de perfil: a similaridade dele caiu para 0,20 enquanto uma criança
marcou 0,35. Quadro a quadro o resultado se inverteria. Classificando a **trilha
inteira** pela média das dez maiores similaridades, a separação volta a ser
limpa: 0,68 contra 0,10–0,27.

## Ajustes

| opção | para quê |
|---|---|
| `--ate SEG` | só procura rosto até esse instante. Se a câmera se afasta das pessoas na metade do vídeo, isso elimina de saída todo falso positivo do resto |
| `--min-trilha N` | quantas detecções uma trilha precisa para não ser ruído (padrão 10). Suba se ainda aparecer borrão fantasma; desça se um rosto de passagem escapar |
| `--forca N` | intensidade da pixelização, maior = mais borrado (padrão 14) |
| `--margem N` | folga ao redor do rosto (padrão 0,30) |
| `--limiar-preservar N` | nota mínima para a trilha ser tratada como a pessoa preservada (padrão 0,40) |

## O princípio

**Na dúvida, borra.** Rosto que escapa é dano real; rosto borrado a mais é custo
estético. Todos os padrões pendem para esse lado — e é por isso que `--relatorio`
existe: quem decide o que ficou bom é você, olhando.

## Ao publicar

Guarde o original e **declare a intervenção** no documento: que os rostos foram
borrados, quem foi preservado e que nada mais foi alterado. Sem isso, a peça fica
exposta à alegação de que o vídeo foi adulterado.
