/**
 * Passo opcional do render: borra rostos de terceiros, preservando quem for
 * indicado.
 *
 * O trabalho pesado esta em `tools/borrar-rostos/borrar_rostos.py`, que usa
 * OpenCV. Aqui e so a ponte: monta a linha de comando, executa e le o JSON.
 *
 * POR QUE PYTHON, E NAO TUDO EM TS
 * --------------------------------
 * A deteccao e o reconhecimento facial precisam do YuNet e do SFace. Em Node
 * daria para rodar os mesmos .onnx por onnxruntime, mas seria preciso
 * reimplementar a decodificacao de ancoras e o NMS do YuNet a mao - muito
 * codigo delicado para replicar o que o OpenCV ja faz em duas linhas. Como o
 * NEXO roda local, com Python e OpenCV na maquina, a ponte sai mais barata e
 * mais confiavel.
 *
 * DEGRADACAO PROPOSITAL
 * ---------------------
 * Se faltar Python, OpenCV ou os modelos, esta funcao NAO derruba o render:
 * registra o motivo e devolve `aplicado: false`. Perder a exportacao inteira
 * por causa de um passo opcional seria pior que entregar sem o borrao - e quem
 * pediu ve o aviso no job e decide.
 */
import { spawn } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import * as logger from "firebase-functions/logger";

/** Onde mora o script. `functions/lib/video` -> raiz do repo. */
const RAIZ_REPO = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(RAIZ_REPO, "tools", "borrar-rostos", "borrar_rostos.py");
const MODELOS = path.join(RAIZ_REPO, "tools", "borrar-rostos", "modelos");

export interface BlurFacesOptions {
  /** Nao borra quem se parecer com o maior rosto neste instante do video (s). */
  preservarRostoEm?: number;
  /** Nao borra quem aparecer nestes retratos (caminhos locais). */
  preservarRetratos?: string[];
  /** So procura rosto ate este instante (s). */
  ate?: number;
  /** Intensidade da pixelizacao; maior = mais borrado. */
  forca?: number;
  /** Deteccoes minimas para uma trilha nao ser tratada como ruido. */
  minTrilha?: number;
  /** Teto de tempo do processo, em ms. */
  timeoutMs?: number;
}

export interface TrilhaRelato {
  inicio_s: number;
  fim_s: number;
  deteccoes: number;
  nota: number;
  acao: "borrado" | "preservado";
}

export interface BlurFacesResult {
  aplicado: boolean;
  /** Preenchido quando `aplicado` e false: por que nao rodou. */
  motivo?: string;
  trilhasBorradas?: number;
  trilhasPreservadas?: number;
  trilhasRuido?: number;
  trilhas?: TrilhaRelato[];
}

/** Verifica o que falta para o passo poder rodar. Null = tudo certo. */
export async function faltaParaBorrarRostos(): Promise<string | null> {
  if (!(await fs.pathExists(SCRIPT))) return `script ausente: ${SCRIPT}`;
  const modelos = ["yunet.onnx", "sface.onnx"];
  for (const m of modelos) {
    if (!(await fs.pathExists(path.join(MODELOS, m)))) {
      return `modelo ausente: ${m} (rode: node scripts/nexo-baixar-modelos-rosto.mjs)`;
    }
  }
  return null;
}

/**
 * Borra rostos de `entrada` gravando em `saida`.
 *
 * Nunca lanca: qualquer falha vira `{ aplicado: false, motivo }`, e cabe a quem
 * chamou seguir com o arquivo original.
 */
export async function borrarRostos(
  entrada: string,
  saida: string,
  opts: BlurFacesOptions = {},
): Promise<BlurFacesResult> {
  const falta = await faltaParaBorrarRostos();
  if (falta) {
    logger.warn(`Borrao de rostos indisponivel: ${falta}`);
    return { aplicado: false, motivo: falta };
  }

  const args = [SCRIPT, entrada, saida, "--json"];
  if (opts.preservarRostoEm !== undefined) {
    args.push("--preservar-rosto-em", String(opts.preservarRostoEm));
  }
  if (opts.preservarRetratos?.length) {
    args.push("--preservar", ...opts.preservarRetratos);
  }
  if (opts.ate !== undefined) args.push("--ate", String(opts.ate));
  if (opts.forca !== undefined) args.push("--forca", String(opts.forca));
  if (opts.minTrilha !== undefined) args.push("--min-trilha", String(opts.minTrilha));

  const python = process.env.NEXO_PYTHON || "python";
  const timeout = opts.timeoutMs ?? 8 * 60 * 1000;

  return await new Promise<BlurFacesResult>((resolve) => {
    let saidaTxt = "";
    let erroTxt = "";
    let encerrado = false;

    const proc = spawn(python, args, { windowsHide: true });
    const relogio = setTimeout(() => {
      encerrado = true;
      proc.kill("SIGKILL");
      logger.warn(`Borrao de rostos passou de ${timeout} ms; render segue sem ele.`);
      resolve({ aplicado: false, motivo: "tempo esgotado" });
    }, timeout);

    proc.stdout.on("data", (d) => (saidaTxt += d.toString()));
    proc.stderr.on("data", (d) => (erroTxt += d.toString()));

    proc.on("error", (e) => {
      clearTimeout(relogio);
      if (encerrado) return;
      // tipicamente "python nao encontrado no PATH"
      logger.warn(`Borrao de rostos nao executou: ${e.message}`);
      resolve({ aplicado: false, motivo: e.message });
    });

    proc.on("close", (code) => {
      clearTimeout(relogio);
      if (encerrado) return;
      if (code !== 0) {
        const motivo = (erroTxt.trim().split("\n").pop() || `codigo ${code}`).slice(0, 300);
        logger.warn(`Borrao de rostos falhou: ${motivo}`);
        return resolve({ aplicado: false, motivo });
      }
      try {
        const r = JSON.parse(saidaTxt.trim().split("\n").pop() || "{}");
        const trilhas: TrilhaRelato[] = r.trilhas ?? [];
        const borradas = trilhas.filter((t) => t.acao === "borrado").length;
        const preservadas = trilhas.filter((t) => t.acao === "preservado").length;
        logger.info(
          `Rostos borrados: ${borradas} trilha(s); preservadas ${preservadas}; ` +
          `${r.trilhas_ruido ?? 0} descartada(s) como ruido.`,
        );
        resolve({
          aplicado: true,
          trilhasBorradas: borradas,
          trilhasPreservadas: preservadas,
          trilhasRuido: r.trilhas_ruido,
          trilhas,
        });
      } catch (e) {
        logger.warn(`Nao entendi a saida do borrao de rostos: ${String(e)}`);
        resolve({ aplicado: false, motivo: "saida ilegivel" });
      }
    });
  });
}
