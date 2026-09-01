# -*- coding: utf-8 -*-
"""
Borra rostos em video ou imagem, opcionalmente preservando pessoas escolhidas.

Serve para publicar material de gabinete sem expor a imagem de terceiros -
tipicamente criancas em unidade escolar - mantendo identificavel quem e objeto
do documento (o agente publico).

O QUE NAO FUNCIONA, E POR QUE ESTA FEITO ASSIM
----------------------------------------------
A tentativa obvia - detectar rosto em cada quadro e borrar - produz lixo:

  1. O detector cospe FALSO POSITIVO em parede, cortina, cartaz. Cada um vira um
     borrao que pisca e some, o que polui o video inteiro.
  2. O reconhecimento facial so separa bem com rosto grande e frontal. Quando a
     pessoa preservada fica pequena ou de perfil, a similaridade dela despenca e
     um terceiro chega a pontuar MAIS que ela - o resultado inverte, borra quem
     devia ficar e preserva quem devia sumir.

A correcao dos dois problemas e a mesma: decidir por TRILHA, nao por quadro.

  - liga as deteccoes ao longo do tempo (mesmo rosto = mesma trilha);
  - descarta trilha curta: falso positivo pisca, rosto de verdade permanece;
  - classifica a TRILHA pela media das maiores similaridades, nao quadro a
    quadro. A trilha inteira separa com folga mesmo quando quadros isolados nao.

PRINCIPIO
---------
Na duvida, BORRA. Rosto que escapa e dano real; rosto borrado a mais e custo
estetico. Todos os limiares abaixo pendem para esse lado.

USO
---
  python borrar_rostos.py entrada.mp4 saida.mp4
  python borrar_rostos.py entrada.mp4 saida.mp4 --preservar-rosto-em 20
  python borrar_rostos.py entrada.mp4 saida.mp4 --preservar retrato.jpg
  python borrar_rostos.py print.png saida.png --preservar retrato.jpg
  python borrar_rostos.py print.png saida.png --referencia-video v.mp4 --preservar-rosto-em 20
  python borrar_rostos.py entrada.mp4 --relatorio        (nao renderiza, so lista)

Requer: opencv-python >= 4.5 e os modelos YuNet/SFace em ./modelos
(baixe com: node scripts/nexo-baixar-modelos-rosto.mjs)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.stderr.write(
        "erro: opencv-python nao instalado.\n"
        "      pip install opencv-python numpy\n")
    raise SystemExit(3)

AQUI = os.path.dirname(os.path.abspath(__file__))
MODELOS = os.path.join(AQUI, "modelos")
YUNET = os.path.join(MODELOS, "yunet.onnx")
SFACE = os.path.join(MODELOS, "sface.onnx")
IMAGENS = (".png", ".jpg", ".jpeg", ".bmp", ".webp")


# ---------------------------------------------------------------- utilidades
def centro(c):
    return (c[0] + c[2] / 2.0, c[1] + c[3] / 2.0)


def carrega_modelos(conf):
    faltando = [p for p in (YUNET, SFACE) if not os.path.exists(p)]
    if faltando:
        sys.stderr.write(
            "erro: modelo(s) ausente(s): %s\n"
            "      rode: node scripts/nexo-baixar-modelos-rosto.mjs\n"
            % ", ".join(os.path.basename(p) for p in faltando))
        raise SystemExit(4)
    det = cv2.FaceDetectorYN.create(YUNET, "", (320, 320), conf, 0.3, 5000)
    rec = cv2.FaceRecognizerSF.create(SFACE, "")
    return det, rec


def borra_regiao(img, caixa, forca):
    """Pixeliza e desfoca uma elipse. Elipse, e nao retangulo, porque retangulo
    preto num documento publico parece censura de processo; elipse suave le como
    protecao de imagem."""
    x, y, w, h = caixa
    x, y = max(0, x), max(0, y)
    w, h = min(w, img.shape[1] - x), min(h, img.shape[0] - y)
    if w <= 2 or h <= 2:
        return
    roi = img[y:y + h, x:x + w]
    peq = cv2.resize(roi, (max(1, w // forca), max(1, h // forca)),
                     interpolation=cv2.INTER_LINEAR)
    pix = cv2.resize(peq, (w, h), interpolation=cv2.INTER_NEAREST)
    pix = cv2.GaussianBlur(pix, (0, 0), max(4.0, w / 8.0))
    masc = np.zeros((h, w), np.uint8)
    cv2.ellipse(masc, (w // 2, h // 2), (int(w * 0.60), int(h * 0.66)),
                0, 0, 360, 255, -1)
    masc = cv2.GaussianBlur(masc, (0, 0), max(3.0, w / 12.0))
    a = (masc.astype(np.float32) / 255.0)[..., None]
    img[y:y + h, x:x + w] = (pix * a + roi * (1 - a)).astype(np.uint8)


def maior_rosto(det, rec, img):
    det.setInputSize((img.shape[1], img.shape[0]))
    _, fs = det.detect(img)
    if fs is None or not len(fs):
        return None
    fs = sorted(fs, key=lambda b: -b[2] * b[3])
    return rec.feature(rec.alignCrop(img, fs[0]))


def referencias(det, rec, args):
    """Assinaturas de quem NAO deve ser borrado."""
    refs = []
    for caminho in args.preservar or []:
        img = cv2.imread(caminho)
        if img is None:
            sys.stderr.write("aviso: nao consegui ler %s\n" % caminho)
            continue
        f = maior_rosto(det, rec, img)
        if f is None:
            sys.stderr.write("aviso: nenhum rosto em %s\n" % caminho)
        else:
            refs.append(f)
    if args.preservar_rosto_em is not None:
        # a referencia pode vir de OUTRO arquivo: e o caso de borrar um print de
        # rede social usando como referencia o video de onde o print saiu
        fonte = args.referencia_video or args.entrada
        if fonte.lower().endswith(IMAGENS):
            sys.stderr.write(
                "aviso: --preservar-rosto-em precisa de um video;"
                " use --referencia-video\n")
            return refs
        cap = cv2.VideoCapture(fonte)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        # varias amostras ao redor do instante pedido: uma so pode cair num
        # quadro de movimento, em que nao ha rosto nitido
        for delta in (0.0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4):
            cap.set(cv2.CAP_PROP_POS_FRAMES,
                    int((args.preservar_rosto_em + delta) * fps))
            ok, img = cap.read()
            if not ok:
                continue
            f = maior_rosto(det, rec, img)
            if f is not None:
                refs.append(f)
        cap.release()
        if not refs:
            sys.stderr.write("aviso: nenhum rosto em %.1fs do video\n"
                             % args.preservar_rosto_em)
    return refs


def similaridade(rec, refs, feat):
    if not refs:
        return -1.0
    return max(rec.match(r, feat, cv2.FaceRecognizerSF_FR_COSINE) for r in refs)


# ---------------------------------------------------------------- imagem
def processa_imagem(args, det, rec, refs):
    img = cv2.imread(args.entrada)
    if img is None:
        sys.stderr.write("erro: nao consegui ler %s\n" % args.entrada)
        raise SystemExit(5)
    det.setInputSize((img.shape[1], img.shape[0]))
    _, fs = det.detect(img)
    borrados = preservados = 0
    detalhe = []
    if fs is not None:
        for b in fs:
            x, y, w, h = b[:4].astype(int)
            if w < args.rosto_minimo or h < args.rosto_minimo:
                continue
            try:
                s = float(similaridade(rec, refs, rec.feature(rec.alignCrop(img, b))))
            except cv2.error:
                s = -1.0
            if s >= args.limiar_preservar:
                preservados += 1
                detalhe.append({"caixa": [int(x), int(y), int(w), int(h)],
                                "sim": round(s, 3), "acao": "preservado"})
                continue
            mx, my = int(w * args.margem), int(h * args.margem)
            borra_regiao(img, (x - mx, y - my, w + 2 * mx, h + 2 * my), args.forca)
            borrados += 1
            detalhe.append({"caixa": [int(x), int(y), int(w), int(h)],
                            "sim": round(s, 3), "acao": "borrado"})
    if not args.relatorio:
        cv2.imwrite(args.saida, img)
    return {"tipo": "imagem", "borrados": borrados, "preservados": preservados,
            "rostos": detalhe, "saida": None if args.relatorio else args.saida}


# ---------------------------------------------------------------- video
def processa_video(args, det, rec, refs):
    cap = cv2.VideoCapture(args.entrada)
    if not cap.isOpened():
        sys.stderr.write("erro: nao consegui abrir %s\n" % args.entrada)
        raise SystemExit(5)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    FPS = cap.get(cv2.CAP_PROP_FPS) or 30.0
    N = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    det.setInputSize((W, H))
    limite = int(args.ate * FPS) if args.ate is not None else N

    # 1) detectar e medir --------------------------------------------------
    cands = []
    for i in range(N):
        ok, img = cap.read()
        if not ok:
            break
        L = []
        if i <= limite:
            _, fs = det.detect(img)
            if fs is not None:
                for b in fs:
                    x, y, w, h = b[:4].astype(int)
                    if w < args.rosto_minimo or h < args.rosto_minimo:
                        continue
                    try:
                        s = float(similaridade(
                            rec, refs, rec.feature(rec.alignCrop(img, b))))
                    except cv2.error:
                        s = -1.0
                    L.append({"box": (x, y, w, h), "s": s})
        cands.append(L)
        if args.verboso and i % 300 == 0:
            sys.stderr.write("  detectando %d/%d\n" % (i, N))
    N = len(cands)

    # 2) ligar em trilhas ---------------------------------------------------
    trilhas, ativas = [], []
    for i in range(N):
        livres = list(cands[i])
        proximas = []
        for tr in ativas:
            if i - tr["ult"] > args.lacuna:
                continue
            cx0, cy0 = centro(tr["box"])
            melhor, md = None, 1e9
            for d in livres:
                cx1, cy1 = centro(d["box"])
                dist = ((cx1 - cx0) ** 2 + (cy1 - cy0) ** 2) ** 0.5
                razao = d["box"][2] / max(1.0, tr["box"][2])
                if dist < md and dist <= args.salto * max(1, i - tr["ult"]) \
                        and 0.5 <= razao <= 2.0:
                    melhor, md = d, dist
            if melhor is not None:
                livres.remove(melhor)
                tr["det"].append((i, melhor["box"], melhor["s"]))
                tr["box"], tr["ult"] = melhor["box"], i
            proximas.append(tr)
        for d in livres:
            t = {"det": [(i, d["box"], d["s"])], "box": d["box"], "ult": i}
            trilhas.append(t)
            proximas.append(t)
        ativas = proximas

    # 3) descartar trilha curta: falso positivo pisca -----------------------
    ruido = [t for t in trilhas if len(t["det"]) < args.min_trilha]
    solidas = [t for t in trilhas if len(t["det"]) >= args.min_trilha]

    # 4) classificar cada trilha -------------------------------------------
    for t in solidas:
        ss = sorted((s for _, _, s in t["det"]), reverse=True)[:10]
        t["nota"] = sum(ss) / max(1, len(ss))
        t["pref"] = bool(refs) and t["nota"] >= args.limiar_preservar

    relato = []
    for t in sorted(solidas, key=lambda x: x["det"][0][0]):
        f0, f1 = t["det"][0][0], t["det"][-1][0]
        relato.append({
            "inicio_s": round(f0 / FPS, 1), "fim_s": round(f1 / FPS, 1),
            "quadros": [f0, f1], "deteccoes": len(t["det"]),
            "nota": round(t["nota"], 3),
            "acao": "preservado" if t["pref"] else "borrado",
        })

    if args.relatorio:
        cap.release()
        return {"tipo": "video", "fps": round(FPS, 2), "quadros": N,
                "trilhas_solidas": len(solidas), "trilhas_ruido": len(ruido),
                "trilhas": relato, "saida": None}

    # 5) caixas por quadro, interpolando POR DENTRO da trilha ---------------
    por_quadro = [[] for _ in range(N)]
    for t in solidas:
        if t["pref"]:
            continue
        d = t["det"]
        for k in range(len(d)):
            f0, b0, _ = d[k]
            por_quadro[f0].append(b0)
            if k + 1 < len(d):
                f1, b1, _ = d[k + 1]
                for f in range(f0 + 1, f1):
                    a = (f - f0) / (f1 - f0)
                    por_quadro[f].append(
                        tuple(int(b0[q] * (1 - a) + b1[q] * a) for q in range(4)))

    # 6) renderizar ---------------------------------------------------------
    filtros = list(args.vf) if args.vf else []
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (W, H),
           "-r", "%.6f" % FPS, "-i", "-",
           "-i", args.entrada, "-map", "0:v", "-map", "1:a?"]
    if filtros:
        cmd += ["-vf", ",".join(filtros)]
    cmd += ["-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium",
            "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
            args.saida]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    total = 0
    for i in range(N):
        ok, img = cap.read()
        if not ok:
            break
        for (x, y, w, h) in por_quadro[i]:
            mx, my = int(w * args.margem), int(h * args.margem)
            borra_regiao(img, (x - mx, y - my, w + 2 * mx, h + 2 * my), args.forca)
            total += 1
        ff.stdin.write(img.tobytes())
    cap.release()
    ff.stdin.close()
    rc = ff.wait()
    if rc != 0:
        sys.stderr.write("erro: ffmpeg saiu com codigo %d\n" % rc)
        raise SystemExit(6)
    return {"tipo": "video", "fps": round(FPS, 2), "quadros": N,
            "trilhas_solidas": len(solidas), "trilhas_ruido": len(ruido),
            "trilhas": relato, "borroes": total, "saida": args.saida}


# ---------------------------------------------------------------- cli
def main():
    p = argparse.ArgumentParser(
        description="Borra rostos em video ou imagem, preservando quem for indicado.")
    p.add_argument("entrada")
    p.add_argument("saida", nargs="?", help="omita junto com --relatorio")
    p.add_argument("--preservar", nargs="*", metavar="FOTO",
                   help="retratos de quem NAO deve ser borrado")
    p.add_argument("--preservar-rosto-em", type=float, metavar="SEG",
                   help="usa como referencia o maior rosto neste instante do video")
    p.add_argument("--referencia-video", metavar="ARQ",
                   help="de qual video tirar a referencia (padrao: a propria entrada)")
    p.add_argument("--relatorio", action="store_true",
                   help="lista as trilhas e sai, sem renderizar (confira antes de gravar)")
    p.add_argument("--json", action="store_true", help="saida em JSON")
    p.add_argument("--ate", type=float, metavar="SEG",
                   help="so procura rosto ate este segundo (o resto e cena sem pessoas)")
    p.add_argument("--forca", type=int, default=14,
                   help="intensidade da pixelizacao; MAIOR = mais borrado (padrao 14)")
    p.add_argument("--margem", type=float, default=0.30,
                   help="folga ao redor do rosto (padrao 0.30)")
    p.add_argument("--min-trilha", type=int, default=10,
                   help="deteccoes minimas para nao ser tratado como ruido (padrao 10)")
    p.add_argument("--conf", type=float, default=0.45,
                   help="confianca minima do detector (padrao 0.45)")
    p.add_argument("--limiar-preservar", type=float, default=0.40,
                   help="nota a partir da qual a trilha e considerada da pessoa preservada")
    p.add_argument("--rosto-minimo", type=int, default=14,
                   help="lado minimo do rosto em pixels (padrao 14)")
    p.add_argument("--salto", type=float, default=55,
                   help="deslocamento maximo do rosto entre quadros (padrao 55 px)")
    p.add_argument("--lacuna", type=int, default=8,
                   help="quadros sem deteccao que a trilha atravessa (padrao 8)")
    p.add_argument("--crf", type=int, default=20, help="qualidade do H.264 (padrao 20)")
    p.add_argument("--vf", nargs="*", default=None,
                   help="filtros ffmpeg extras aplicados depois do borrao")
    p.add_argument("--verboso", action="store_true")
    args = p.parse_args()

    if not args.relatorio and not args.saida:
        p.error("informe a saida, ou use --relatorio")
    if not os.path.exists(args.entrada):
        sys.stderr.write("erro: entrada nao encontrada: %s\n" % args.entrada)
        raise SystemExit(2)

    det, rec = carrega_modelos(args.conf)
    refs = referencias(det, rec, args)
    ehimg = args.entrada.lower().endswith(IMAGENS)
    r = (processa_imagem if ehimg else processa_video)(args, det, rec, refs)
    r["referencias"] = len(refs)

    if args.json:
        print(json.dumps(r, ensure_ascii=False))
    elif r["tipo"] == "imagem":
        print("imagem: %d rosto(s) borrado(s), %d preservado(s)"
              % (r["borrados"], r["preservados"]))
    else:
        print("trilhas solidas: %d | descartadas como ruido: %d"
              % (r["trilhas_solidas"], r["trilhas_ruido"]))
        for t in r["trilhas"]:
            print("  %5.1fs..%5.1fs  %4d det  nota %.2f  %s"
                  % (t["inicio_s"], t["fim_s"], t["deteccoes"], t["nota"], t["acao"]))
        if r["saida"]:
            print("gravado: %s (%d borroes)" % (r["saida"], r["borroes"]))
        else:
            print("(relatorio: nada foi gravado)")


if __name__ == "__main__":
    main()
