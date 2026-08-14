/**
 * Upload de assets para Firebase Storage.
 *
 * Path: `videoProjects/{projectId}/assets/{uuid}-{filename}`.
 * Usa `uploadBytesResumable` para reportar progresso.
 *
 * Não interage com o Firestore — apenas faz o upload e devolve a
 * referência. Quem chama é responsável por salvar `storagePath`/
 * `downloadUrl` no `MediaAsset` correspondente.
 */

import {
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
  type FirebaseStorage,
} from 'firebase/storage';

export interface UploadAssetResult {
  storagePath: string;
  downloadUrl: string;
  size: number;
}

/** Sanitiza nome para o Storage (remove acentos/caracteres ruins). */
function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
}

function genUploadId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Faz upload de um arquivo único.
 *
 * @param storage instância do Firebase Storage.
 * @param projectId id do projeto (para path).
 * @param file arquivo a enviar.
 * @param onProgress callback opcional 0-100.
 */
export async function uploadAsset(
  storage: FirebaseStorage,
  projectId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadAssetResult> {
  const safeName = sanitizeFilename(file.name);
  const storagePath = `videoProjects/${projectId}/assets/${genUploadId()}-${safeName}`;
  const ref = storageRef(storage, storagePath);

  const task = uploadBytesResumable(ref, file, {
    contentType: file.type || 'application/octet-stream',
  });

  return new Promise<UploadAssetResult>((resolve, reject) => {
    task.on(
      'state_changed',
      (snapshot) => {
        if (onProgress) {
          const pct =
            snapshot.totalBytes > 0
              ? (snapshot.bytesTransferred / snapshot.totalBytes) * 100
              : 0;
          onProgress(pct);
        }
      },
      (error) => reject(error),
      async () => {
        try {
          const downloadUrl = await getDownloadURL(task.snapshot.ref);
          resolve({
            storagePath,
            downloadUrl,
            size: file.size,
          });
        } catch (err) {
          reject(err);
        }
      },
    );
  });
}

/**
 * Faz upload de vários arquivos em paralelo.
 *
 * @param onAssetProgress recebe `(filename, pct)` em cada update.
 *   Não exposto por id porque o caller é quem cria os ids.
 */
export async function uploadAssets(
  storage: FirebaseStorage,
  projectId: string,
  files: File[],
  onAssetProgress?: (filename: string, pct: number) => void,
): Promise<UploadAssetResult[]> {
  return Promise.all(
    files.map((file) =>
      uploadAsset(storage, projectId, file, (pct) => {
        onAssetProgress?.(file.name, pct);
      }),
    ),
  );
}
