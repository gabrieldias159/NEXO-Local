/**
 * Baixa os modelos de deteccao e reconhecimento facial usados por
 * `tools/borrar-rostos/borrar_rostos.py`.
 *
 * Os modelos NAO vao para o git: sao 38 MB e sao artefato de terceiro, com
 * licenca propria. Ficam em `tools/borrar-rostos/modelos/`, ignorado.
 *
 * PEGADINHA que custa meia hora: o opencv_zoo guarda os .onnx em Git LFS.
 * Baixar de `raw.githubusercontent.com` devolve 200 OK com um PONTEIRO de 130
 * bytes, nao o modelo - e o OpenCV so reclama la na frente, com erro obscuro de
 * parse. A URL que resolve o LFS e `media.githubusercontent.com/media/...`.
 * Por isso a verificacao de tamanho minimo abaixo: e o que denuncia o ponteiro.
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = join(RAIZ, 'tools', 'borrar-rostos', 'modelos');

const MODELOS = [
  {
    arquivo: 'yunet.onnx',
    minKB: 150,
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    oque: 'YuNet - detecta onde estao os rostos',
  },
  {
    arquivo: 'sface.onnx',
    minKB: 30000,
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    oque: 'SFace - diz se dois rostos sao a mesma pessoa',
  },
];

mkdirSync(DESTINO, { recursive: true });

let faltou = false;
for (const m of MODELOS) {
  const alvo = join(DESTINO, m.arquivo);
  if (existsSync(alvo) && statSync(alvo).size / 1024 >= m.minKB) {
    console.log(`ja tenho  ${m.arquivo}  (${(statSync(alvo).size / 1024 / 1024).toFixed(1)} MB)`);
    continue;
  }
  process.stdout.write(`baixando ${m.arquivo} — ${m.oque} ... `);
  try {
    const r = await fetch(m.url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const kb = buf.length / 1024;
    if (kb < m.minKB) {
      // quase certamente o ponteiro de LFS, nao o modelo
      throw new Error(
        `veio so ${kb.toFixed(0)} KB (esperado >= ${m.minKB} KB). ` +
        `Provavelmente um ponteiro de Git LFS — confira a URL.`,
      );
    }
    writeFileSync(alvo, buf);
    console.log(`ok (${(kb / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.log('FALHOU');
    console.error(`   ${e.message}`);
    faltou = true;
  }
}

if (faltou) {
  console.error('\nAlgum modelo nao baixou. Sem eles o borrao de rostos fica indisponivel');
  console.error('e o render segue normalmente, apenas sem borrar (degradacao proposital).');
  process.exit(1);
}
console.log(`\nmodelos em ${DESTINO}`);
console.log('teste:  python tools/borrar-rostos/borrar_rostos.py VIDEO.mp4 --relatorio');
