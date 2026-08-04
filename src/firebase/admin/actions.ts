'use client';
import {
  doc,
  updateDoc,
  Firestore,
  runTransaction,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  arrayUnion,
  setDoc,
  getDoc,
  deleteDoc,
  writeBatch,
  deleteField,
  DocumentReference,
  DocumentSnapshot,
  DocumentData,
  Timestamp,
} from 'firebase/firestore';
import { FirebaseStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject, listAll } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { errorEmitter } from '../error-emitter';
import { FirestorePermissionError } from '../errors';
import type { Oficio, Requerimento, Indicacao, IndicacaoStatus, RecorteFolder, RecorteVideo, CompressionJob, OficioAttachment, QuickEditJob, Compromisso, ProjetoDeLei, ViabilityStudy, SaplMateria, OficioImportData, OficioStatus, RequerimentoStatus, ProjetoDeLeiStatus, ImportBatch, ImportBatchFile, OficioImportLog, Transcription } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';


/**
 * Remove recursivamente quaisquer chaves de objeto cujo valor seja `undefined`.
 *
 * O Web SDK do Firestore rejeita qualquer campo com valor `undefined`
 * (ex.: `attachments: [{ nota: undefined }]` derruba a transação inteira).
 * Este sanitizador faz um deep-clone removendo essas chaves, preservando:
 *  - `null` (mantido como está — não é o mesmo que ausente);
 *  - primitivos (string/number/boolean);
 *  - `Date` e `Timestamp` do Firestore (passam intactos, sem recursão);
 *  - quaisquer instâncias não-plain (FieldValue, etc.) — passam intactas.
 * Recursão apenas em objetos "plain" e arrays.
 */
function semUndefined<T>(v: T): T {
  // Arrays: sanitiza cada elemento (mantém os elementos, inclusive `null`).
  if (Array.isArray(v)) {
    return v.map((item) => semUndefined(item)) as unknown as T;
  }

  // Não-objetos (string/number/boolean/null) passam direto.
  if (v === null || typeof v !== 'object') {
    return v;
  }

  // Date e Timestamp do Firestore devem passar intactos (sem recursão).
  if (v instanceof Date || v instanceof Timestamp) {
    return v;
  }

  // Apenas objetos "plain" são clonados/recursados. Qualquer outra instância
  // de classe (ex.: FieldValue do arrayUnion/serverTimestamp) passa intacta.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    return v;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (value === undefined) continue; // descarta chaves undefined
    out[key] = semUndefined(value);
  }
  return out as unknown as T;
}


/**
 * Helper function to upload a file to Firebase Storage and get its URL.
 * This is a private helper function for this module.
 * @param storage - The FirebaseStorage instance.
 * @param path - The full path in the storage bucket where the file should be saved.
 * @param file - The File object to upload.
 * @returns A promise that resolves to an object with the file name and public URL.
 * @throws An error with a user-friendly message if the upload fails.
 */
async function _uploadFile(
  storage: FirebaseStorage,
  path: string,
  file: File
): Promise<{ name: string; url: string; path: string }> {
  const fileRef = storageRef(storage, path);
  try {
    const snapshot = await uploadBytes(fileRef, file);
    const url = await getDownloadURL(snapshot.ref);
    return { name: file.name, url, path: snapshot.ref.fullPath };
  } catch (error: any) {
    console.error(`Storage upload error at path ${path}:`, error);
    // This generic error helps guide the user to the most common root causes (CORS/Rules).
    throw new Error(
      'Falha ao enviar o arquivo. Verifique a configuração de CORS do seu bucket e as regras de segurança do Firebase Storage.'
    );
  }
}


// USER MANAGEMENT ACTIONS
export function updateUserRole(db: Firestore, uid: string, role: 'admin' | 'user') {
  const userRef = doc(db, 'users', uid);
  const data = { role };
  
  updateDoc(userRef, data).catch((error) => {
    const permissionError = new FirestorePermissionError({
      path: userRef.path,
      operation: 'update',
      requestResourceData: data,
    });
    errorEmitter.emit('permission-error', permissionError);
  });
}

export function updateUserStatus(db: Firestore, uid: string, isActive: boolean) {
  const userRef = doc(db, 'users', uid);
  const data = { isActive };

  updateDoc(userRef, data).catch((error) => {
    const permissionError = new FirestorePermissionError({
      path: userRef.path,
      operation: 'update',
      requestResourceData: data,
    });
    errorEmitter.emit('permission-error', permissionError);
  });
}

/**
 * Promove/rebaixa um usuário via callable `setUserRole` (custom claims).
 * Substitui a escrita direta de `role` no doc: o privilégio agora vive no
 * claim do token e a regra do Firestore bloqueia auto-edição de role.
 * Lança em caso de erro (o chamador trata com toast).
 */
export async function setUserRole(uid: string, role: 'admin' | 'user'): Promise<void> {
  const callable = httpsCallable<{ uid: string; role: 'admin' | 'user' }, { ok: boolean }>(
    getFunctions(getApp(), 'us-central1'),
    'setUserRole',
  );
  await callable({ uid, role });
}

/**
 * Migração one-shot: seta custom claims para os admins que hoje só têm
 * `role: 'admin'` no doc (+ o admin-semente). Retorna quantos foram migrados.
 */
export async function syncAdminClaims(): Promise<number> {
  const callable = httpsCallable<Record<string, never>, { ok: boolean; migrated: number }>(
    getFunctions(getApp(), 'us-central1'),
    'syncAdminClaims',
  );
  const res = await callable({});
  return res.data.migrated;
}

export interface DiarioSanearResult {
  dryRun: boolean;
  duplicatesFound: number;
  duplicatesDeleted: number;
  entitiesRecount: number;
  entitiesScanned: number;
  entitiesUpdated: number;
}

/**
 * Saneamento dos dados históricos do Diário (dedup de matérias + recount de
 * entidades). Use `dryRun: true` para simular sem alterar nada.
 */
export async function sanearDiario(dryRun: boolean): Promise<DiarioSanearResult> {
  const callable = httpsCallable<{ dryRun: boolean }, DiarioSanearResult>(
    getFunctions(getApp(), 'us-central1'),
    'onDiarioSanear',
  );
  const res = await callable({ dryRun });
  return res.data;
}

export interface GerarCapasResult {
  gerados: number;
  restantes: number;
  erros: number;
}

/**
 * Backfill das capas dos vídeos de Recortes já enviados (gera 1 frame via
 * ffmpeg server-side). Processa em lotes; chamar repetidamente até restantes=0.
 */
export async function gerarCapasRecortes(limite = 20): Promise<GerarCapasResult> {
  const callable = httpsCallable<{ limite: number }, { ok: boolean } & GerarCapasResult>(
    getFunctions(getApp(), 'us-central1'),
    'onGerarCapasRecortes',
  );
  const res = await callable({ limite });
  return res.data;
}

/**
 * Backfill dos PREVIEWS (rendition leve 720p+faststart, servida de São Paulo)
 * dos vídeos de Recortes já enviados. Transcode é pesado → lotes pequenos;
 * chamar repetidamente até restantes=0.
 */
export async function gerarPreviewsRecortes(limite = 5): Promise<GerarCapasResult> {
  const callable = httpsCallable<{ limite: number }, { ok: boolean } & GerarCapasResult>(
    getFunctions(getApp(), 'us-central1'),
    'onGerarPreviewsRecortes',
  );
  const res = await callable({ limite });
  return res.data;
}


// NUMBERING MANAGEMENT ACTIONS
export async function updateNumberingConfig(
  db: Firestore,
  actorUid: string,
  docType: 'oficio' | 'requerimento',
  year: number,
  nextNumber: number
) {
  const configRef = doc(db, 'numbering', `${docType}-${year}`);

  try {
    await runTransaction(db, async (transaction) => {
      const configDoc = await transaction.get(configRef);
      const oldNumber = configDoc.exists() ? configDoc.data().nextNumber : null;

      // 1. Update or create the numbering config
      transaction.set(configRef, { type: docType, year, nextNumber }, { merge: true });

      // 2. Create an audit log entry
      const auditLogRef = doc(collection(db, 'audit-logs'));
      transaction.set(auditLogRef, {
        actorUid,
        action: 'update_numbering_config',
        timestamp: new Date(),
        details: {
          docType,
          year,
          oldValue: oldNumber,
          newValue: nextNumber,
        },
      });
    });
  } catch (error) {
     const permissionError = new FirestorePermissionError({
      path: `numbering/${docType}-${year} or audit-logs`,
      operation: 'update',
      requestResourceData: { nextNumber }
    });
    errorEmitter.emit('permission-error', permissionError);
    // Re-throw the error to be caught by the caller
    throw error;
  }
}

// OFICIO CREATION
export async function createOficio(
  db: Firestore,
  actorUid: string,
  values: {
    numero: string;
    ano: number;
    dataOficio: string; // YYYY-MM-DD
    destinatario: string;
    cargoDestinatario: string;
    vocativo: string;
    assunto: string;
    corpo: string;
    omitirDia?: boolean;
  },
  imageAttachmentUrls: { name: string; url: string; path: string; nota?: string }[],
  audioAttachmentUrls: { name: string; url: string; path: string }[]
): Promise<string> {
  const numberingRef = doc(db, 'numbering', `oficio-${values.ano}`);
  const uniqueRef = doc(db, 'unique_oficios', `${values.ano}-${values.numero}`);

  try {
    const newOficioId = await runTransaction(db, async (transaction) => {
      // 1. Check for duplicates inside the transaction for atomicity
      const uniqueDoc = await transaction.get(uniqueRef);
      if (uniqueDoc.exists()) {
        throw new Error(`O ofício número ${values.numero}/${values.ano} já existe.`);
      }

      const numberingDoc = await transaction.get(numberingRef);
      const currentNextNumber = numberingDoc.exists() ? numberingDoc.data().nextNumber || 1 : 1;

      const newOficioRef = doc(collection(db, 'oficios'));

      const newOficioData = {
        destinatario: values.destinatario,
        cargoDestinatario: values.cargoDestinatario,
        vocativo: values.vocativo,
        assunto: values.assunto,
        corpo: values.corpo,
        id: newOficioRef.id,
        numero: values.numero,
        ano: values.ano,
        status: 'Rascunho' as const,
        authorUid: actorUid,
        createdAt: new Date(`${values.dataOficio}T12:00:00`), // Use user's date, but set time to midday to avoid timezone shifts across midnight
        updatedAt: new Date(),
        omitirDia: values.omitirDia ?? false,
        attachments: imageAttachmentUrls,
        audioAttachments: audioAttachmentUrls,
        eventLog: [
          {
            status: 'Rascunho' as const,
            actorUid: actorUid,
            timestamp: new Date(),
            notes: 'Documento criado',
          },
        ],
      };

      transaction.set(newOficioRef, semUndefined(newOficioData));

      // Create the uniqueness document
      transaction.set(uniqueRef, { oficioId: newOficioRef.id });

      // Only update numbering if the used number is moving the sequence forward
      if (parseInt(values.numero, 10) >= currentNextNumber) {
        transaction.set(numberingRef, {
          type: 'oficio',
          year: values.ano,
          nextNumber: parseInt(values.numero, 10) + 1,
        }, { merge: true });
      }

      return newOficioRef.id;
    });

    return newOficioId;
  } catch (error) {
    if (error instanceof Error && error.message.includes('já existe')) {
        throw error;
    }

    console.error("Transaction failed: ", error);
    const permissionError = new FirestorePermissionError({
        path: `oficios or numbering/oficio-${values.ano}`,
        operation: 'write',
        requestResourceData: values
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Não foi possível gerar o ofício. A transação falhou, possivelmente devido a um conflito ou problema de permissão. Tente novamente.');
  }
}

export async function importOficioFromPdf(
  db: Firestore,
  storage: FirebaseStorage,
  actorUid: string,
  values: OficioImportData & { status: OficioStatus },
  originalPdf: File
): Promise<string> {
  const newOficioRef = doc(collection(db, 'oficios'));
  
  // 1. Check for duplicates before starting the transaction
  const q = query(
    collection(db, 'oficios'),
    where('ano', '==', values.ano),
    where('numero', '==', values.numero)
  );
  const existingDoc = await getDocs(q);
  if (!existingDoc.empty) {
    // throw new Error(`O ofício número ${values.numero}/${values.ano} já existe.`);
    const existingOficioId = existingDoc.docs[0].id;
    await addCommentToOficio(db, storage, existingOficioId, { uid: actorUid, displayName: 'Sistema' }, `Tentativa de importar documento duplicado: ${originalPdf.name}. O arquivo foi anexado a este ofício existente para referência.`, [originalPdf]);
    throw new Error(`O ofício número ${values.numero}/${values.ano} já existe. O novo PDF foi adicionado como um comentário ao ofício existente.`);
  }

  const numberingRef = doc(db, 'numbering', `oficio-${values.ano}`);
  const uniqueRef = doc(db, 'unique_oficios', `${values.ano}-${values.numero}`);

  let pdfAttachment: { name: string, url: string, path: string };
  try {
    const pdfPath = `oficios/${newOficioRef.id}/original_import/${originalPdf.name}`;
    pdfAttachment = await _uploadFile(storage, pdfPath, originalPdf);
  } catch (storageError) {
    console.error("Storage Error during import:", storageError);
    throw new Error("Falha ao enviar o arquivo PDF para o armazenamento.");
  }


  try {
    const newOficioId = await runTransaction(db, async (transaction) => {
      // P2-5: atomic duplicate guard. The getDocs check above handles the
      // "anexar a um ofício já existente como comentário" UX, but two imports
      // of the same new number racing in parallel would both pass it. Reading
      // unique_oficios inside the transaction closes that window.
      const uniqueDoc = await transaction.get(uniqueRef);
      if (uniqueDoc.exists()) {
        throw new Error(`O ofício número ${values.numero}/${values.ano} já existe.`);
      }

      const numberingDoc = await transaction.get(numberingRef);
      const currentNextNumber = numberingDoc.exists() ? numberingDoc.data().nextNumber || 1 : 1;
      
      const newOficioData: Omit<Oficio, 'id'> = {
        destinatario: values.destinatario,
        cargoDestinatario: values.cargoDestinatario,
        vocativo: values.vocativo,
        assunto: values.assunto,
        corpo: values.corpo,
        numero: values.numero,
        ano: values.ano,
        status: values.status,
        authorUid: actorUid,
        createdAt: new Date(`${values.dataOficio}T12:00:00`),
        updatedAt: new Date(),
        attachments: [],
        eventLog: [{
            status: values.status,
            actorUid,
            timestamp: new Date(),
            notes: `Documento importado via PDF.`,
        }],
      };
      transaction.set(newOficioRef, { ...newOficioData, id: newOficioRef.id });

      // P2-5: register the uniqueness doc so concurrent imports/creates collide.
      transaction.set(uniqueRef, { oficioId: newOficioRef.id });

      const logRef = doc(collection(db, 'oficio-import-logs'));
      const logData: Omit<OficioImportLog, 'id'> = {
        actorUid,
        importedAt: new Date() as any,
        oficioId: newOficioRef.id,
        oficioNumero: values.numero,
        oficioAno: values.ano,
        status: 'imported',
        originalPdfPath: pdfAttachment.path, // Save path instead of URL
        importData: { ...values },
      }
      transaction.set(logRef, { ...logData, id: logRef.id });
      
      if (parseInt(values.numero, 10) >= currentNextNumber) {
        transaction.set(numberingRef, {
          type: 'oficio',
          year: values.ano,
          nextNumber: parseInt(values.numero, 10) + 1,
        }, { merge: true });
      }

      return newOficioRef.id;
    });

    return newOficioId;

  } catch (error) {
    if (error instanceof Error && error.message.includes('já existe')) {
        throw error;
    }
    console.error("Transaction failed during import: ", error);
    const permissionError = new FirestorePermissionError({
      path: `oficios or numbering/oficio-${values.ano}`,
      operation: 'write',
      requestResourceData: values,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Não foi possível importar o ofício. A transação falhou.');
  }
}

export async function saveOficioPdf(
  db: Firestore,
  storage: FirebaseStorage,
  oficioId: string,
  actorUid: string,
  pdfFile: File
): Promise<{ pdfUrl: string; pdfPath: string }> {
  const oficioRef = doc(db, 'oficios', oficioId);
  const docSnap = await getDoc(oficioRef);
  if (!docSnap.exists()) {
    throw new Error("Oficio não encontrado para adicionar o PDF.");
  }
  const oficioData = docSnap.data() as Oficio;
  const oldPdfPath = oficioData.pdfPath;

  // Use a consistent file path
  const newFilePath = `oficios/${oficioId}/oficio-${oficioData.numero}-${oficioData.ano}.pdf`;
  
  // Delete old file if path is different (for legacy files with timestamps)
  if (oldPdfPath && oldPdfPath !== newFilePath) {
    const oldFileRef = storageRef(storage, oldPdfPath);
    try {
      await deleteObject(oldFileRef);
    } catch (deleteError: any) {
      if (deleteError.code !== 'storage/object-not-found') {
        console.warn(`Failed to delete old PDF at ${oldPdfPath}:`, deleteError);
      }
    }
  }

  const newFileRef = storageRef(storage, newFilePath);
  try {
    const snapshot = await uploadBytes(newFileRef, pdfFile);
    const pdfUrl = await getDownloadURL(snapshot.ref);

    const dataToUpdate = {
      pdfUrl: pdfUrl,
      pdfPath: newFilePath, // save the consistent path
      updatedAt: new Date(),
      eventLog: arrayUnion({
        status: oficioData.status,
        actorUid: actorUid,
        timestamp: new Date(),
        notes: 'PDF do ofício foi gerado/recriado e salvo.',
      }),
    };

    await updateDoc(oficioRef, dataToUpdate);

    return { pdfUrl: pdfUrl, pdfPath: newFilePath };
  } catch (error: any) {
    console.error("PDF upload/update error:", error);
    const permissionError = new FirestorePermissionError({
      path: oficioRef.path,
      operation: 'update',
      requestResourceData: { pdfUrl: '...' },
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao salvar o PDF do ofício.');
  }
}


// REQUERIMENTO CREATION
export async function createRequerimento(
  db: Firestore,
  actorUid: string,
  values: {
    numero: string;
    ano: number;
    dataRequerimento: string;
    assunto: string;
    destinatario: string;
    corpo: string;
    originalCorpo?: string;
  },
  attachmentUrls: { name: string; url: string; path: string }[]
): Promise<string> {
  const numberingRef = doc(db, 'numbering', `requerimento-${values.ano}`);
  const uniqueRef = doc(db, 'unique_requerimentos', `${values.ano}-${values.numero}`);

  try {
    const newRequerimentoId = await runTransaction(db, async (transaction) => {
      // 1. Check for duplicates inside the transaction for atomicity
      const uniqueDoc = await transaction.get(uniqueRef);
      if (uniqueDoc.exists()) {
          throw new Error(`O requerimento número ${values.numero}/${values.ano} já existe.`);
      }
      
      const numberingDoc = await transaction.get(numberingRef);
      const currentNextNumber = numberingDoc.exists() ? numberingDoc.data().nextNumber || 1 : 1;
      
      const newRequerimentoRef = doc(collection(db, 'requerimentos'));

      const newRequerimentoData = {
        assunto: values.assunto,
        destinatario: values.destinatario,
        corpo: values.corpo,
        originalCorpo: values.originalCorpo,
        id: newRequerimentoRef.id,
        numero: values.numero,
        ano: values.ano,
        status: 'Rascunho' as const,
        authorUid: actorUid,
        createdAt: new Date(`${values.dataRequerimento}T12:00:00`),
        updatedAt: new Date(),
        attachments: attachmentUrls,
        eventLog: [
          {
            status: 'Rascunho' as const,
            actorUid,
            timestamp: new Date(),
            notes: 'Documento criado',
          },
        ],
      };

      transaction.set(newRequerimentoRef, newRequerimentoData);

      // Create the uniqueness document
      transaction.set(uniqueRef, { requerimentoId: newRequerimentoRef.id });

      // Only update numbering if the used number is moving the sequence forward
      if (parseInt(values.numero, 10) >= currentNextNumber) {
        transaction.set(numberingRef, {
          type: 'requerimento',
          year: values.ano,
          nextNumber: parseInt(values.numero, 10) + 1,
        }, { merge: true });
      }

      return newRequerimentoRef.id;
    });

    return newRequerimentoId;
  } catch (error) {
    if (error instanceof Error && error.message.includes('já existe')) {
        throw error;
    }
    console.error("Transaction failed: ", error);
    const permissionError = new FirestorePermissionError({
        path: `requerimentos or numbering/requerimento-${values.ano}`,
        operation: 'write',
        requestResourceData: values
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Não foi possível gerar o número do requerimento. A transação falhou, possivelmente devido a um conflito ou problema de permissão. Tente novamente.');
  }
}


// OFICIO WORKFLOW ACTIONS

async function updateOficioStatus(
  db: Firestore,
  oficioId: string,
  actorUid: string,
  newStatus: string,
  notes: string,
  additionalData: object = {}
) {
  const oficioRef = doc(db, 'oficios', oficioId);
  const event = { status: newStatus, actorUid, timestamp: new Date(), notes };
  const dataToUpdate = {
    ...additionalData,
    status: newStatus,
    updatedAt: new Date(),
    eventLog: arrayUnion(event)
  };

  try {
    await updateDoc(oficioRef, dataToUpdate);
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: oficioRef.path,
      operation: 'update',
      requestResourceData: dataToUpdate,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao atualizar o status do ofício.');
  }
}

export async function changeOficioStatus(db: Firestore, oficioId: string, actorUid: string, newStatus: OficioStatus) {
    await updateOficioStatus(db, oficioId, actorUid, newStatus, `Status alterado para "${newStatus}".`);
}

export async function updateOficioContent(
  db: Firestore,
  oficioId: string,
  actorUid: string,
  newData: Partial<Pick<Oficio, 'destinatario' | 'cargoDestinatario' | 'vocativo' | 'assunto' | 'corpo' | 'attachments' | 'omitirDia'>> & {
    /** YYYY-MM-DD — quando informado, sobrescreve `createdAt` (data do oficio). */
    dataOficio?: string;
  }
) {
  const oficioRef = doc(db, 'oficios', oficioId);

  const currentDoc = await getDoc(oficioRef);
  if (!currentDoc.exists()) {
    throw new Error("Ofício não encontrado.");
  }
  const currentStatus = currentDoc.data().status as OficioStatus;

  const { dataOficio, ...rest } = newData;
  const dataToUpdate: Record<string, any> = {
    ...rest,
    updatedAt: new Date(),
    eventLog: arrayUnion({
      status: currentStatus,
      actorUid,
      timestamp: new Date(),
      notes: 'Conteúdo do ofício foi editado.',
    }),
  };
  if (dataOficio) {
    dataToUpdate.createdAt = new Date(`${dataOficio}T12:00:00`);
  }

  try {
    await updateDoc(oficioRef, semUndefined(dataToUpdate));
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: oficioRef.path,
      operation: 'update',
      requestResourceData: dataToUpdate,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao salvar as alterações do ofício.');
  }
}

export async function approveOficio(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Aprovado', 'Documento aprovado.', {
    approvedAt: new Date(),
    approvedBy: actorUid,
  });
}

export async function fileOficio(
  db: Firestore,
  storage: FirebaseStorage,
  oficioId: string,
  actor: { uid: string; displayName: string | null },
  data: { protocolNumber?: string; protocolDate: string; file?: File }
) {
    let attachment: OficioAttachment | undefined;

    if (data.file) {
      const filePath = `oficios/${oficioId}/protocol/${Date.now()}-${data.file.name}`;
      try {
        const { name, url, path } = await _uploadFile(storage, filePath, data.file);
        attachment = {
            name: name,
            url: url,
            path: path,
            uploadedAt: new Date(),
            uploadedBy: actor.uid
        };
      } catch (error: any) {
          console.error('Error in fileOficio upload:', error);
          throw error;
      }
    }

    const protocolData: { [key: string]: any } = {
        protocolAt: new Date(`${data.protocolDate}T12:00:00`),
        protocolBy: actor.uid,
        protocolNumber: data.protocolNumber || '',
    };
    if (attachment) {
      protocolData.protocoloArquivo = attachment;
    } else {
      protocolData.protocoloArquivo = deleteField();
    }

    await updateOficioStatus(db, oficioId, actor.uid, 'Protocolado', `Protocolado com número: ${data.protocolNumber || 'N/A'}.`, protocolData);
    
    const actorName = actor.displayName || actor.uid;
    const commentRef = collection(db, `oficios/${oficioId}/comments`);
    const commentData: any = {
        author: 'Sistema',
        authorUid: 'system',
        date: new Date(),
        text: `Documento protocolado por ${actorName} em ${new Date(`${data.protocolDate}T12:00:00`).toLocaleDateString('pt-BR')}.`,
        attachments: attachment ? [attachment] : []
    };
    await addDoc(commentRef, commentData);
}

export async function fileOficioWithExistingAttachments(
  db: Firestore,
  oficioId: string,
  actorUid: string,
  data: { protocolNumber?: string; protocolDate: string; attachments: { name: string; url: string; path?: string }[] }
) {
    if (data.attachments.length === 0) {
        throw new Error("Nenhum anexo fornecido.");
    }
    const firstAttachment = data.attachments[0];

    const protocolData = {
        protocolAt: new Date(`${data.protocolDate}T12:00:00`),
        protocolBy: actorUid,
        protocolNumber: data.protocolNumber || '',
        protocoloArquivo: {
            ...firstAttachment,
            uploadedAt: new Date(),
            uploadedBy: 'public-upload'
        }
    };
    await updateOficioStatus(db, oficioId, actorUid, 'Protocolado', `Protocolado via upload externo com número: ${data.protocolNumber || 'N/A'}.`, protocolData);

    // Add system comment
    const commentRef = collection(db, `oficios/${oficioId}/comments`);
    const commentData = {
        author: 'Sistema',
        authorUid: 'system',
        date: new Date(),
        text: 'Documento protocolado via upload externo.',
        attachments: data.attachments
    };
    addDoc(commentRef, commentData).catch(err => console.error("Failed to add protocol comment", err));
}

export async function setAwaitingResponse(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Aguardando Resposta', 'Aguardando resposta do destinatário.');
}

export async function closeOficio(db: Firestore, oficioId: string, actorUid:string) {
    await updateOficioStatus(db, oficioId, actorUid, 'Encerrado', 'Processo encerrado.', {
        closedAt: new Date(),
        closedBy: actorUid,
    });
}

export async function addResponseToOficio(
  db: Firestore,
  storage: FirebaseStorage,
  oficioId: string,
  actor: { uid: string; displayName: string | null },
  data: { responseSummary?: string; respondedAt: string; file?: File }
) {
    let attachment: OficioAttachment | undefined;

    if (data.file) {
        const filePath = `oficios/${oficioId}/response/${Date.now()}-${data.file.name}`;
        try {
            const { name, url, path } = await _uploadFile(storage, filePath, data.file);
            attachment = {
                name: name,
                url: url,
                path: path,
                uploadedAt: new Date(),
                uploadedBy: actor.uid
            };
        } catch (error: any) {
            console.error('Error in addResponseToOficio upload:', error);
            throw error;
        }
    }

    const responseData: { [key: string]: any } = {
        respondedAt: new Date(`${data.respondedAt}T12:00:00`),
        respondedBy: actor.uid,
        responseSummary: data.responseSummary || '',
    };
    if (attachment) {
        responseData.respostaArquivo = attachment;
    } else {
        responseData.respostaArquivo = deleteField();
    }

    await updateOficioStatus(db, oficioId, actor.uid, 'Respondido', 'Resposta recebida e anexada.', responseData);
    
    // Add a system comment for the response
    const actorName = actor.displayName || actor.uid;
    const commentRef = collection(db, `oficios/${oficioId}/comments`);
    const commentData: any = {
        author: 'Sistema',
        authorUid: 'system',
        date: new Date(),
        text: `Resposta anexada por ${actorName} em ${new Date().toLocaleDateString('pt-BR')}.${data.responseSummary ? `\nResumo: ${data.responseSummary}` : ''}`.trim(),
        attachments: attachment ? [attachment] : []
    };
    addDoc(commentRef, commentData).catch(err => console.error("Failed to add response comment", err));
}

export async function revertToResponded(db: Firestore, oficioId: string, actorUid: string) {
    await updateOficioStatus(db, oficioId, actorUid, 'Respondido', 'Status revertido para "Respondido" pelo Administrador.');
}

// OFICIO LIXEIRA (TRASH) / CANCELADO ACTIONS
export async function moveOficioToTrash(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Lixeira', 'Movido para a lixeira.');
}

export async function restoreOficioFromTrash(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Rascunho', 'Restaurado da lixeira.');
}

export async function cancelOficio(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Cancelado', 'Ofício cancelado.');
}

export async function restoreOficioFromCancelado(db: Firestore, oficioId: string, actorUid: string) {
  await updateOficioStatus(db, oficioId, actorUid, 'Rascunho', 'Restaurado da lista de cancelados.');
}

export async function deleteOficioPermanently(db: Firestore, storage: FirebaseStorage, oficioId: string): Promise<void> {
  const oficioRef = doc(db, 'oficios', oficioId);
  try {
    const oficioDoc = await getDoc(oficioRef);
    if (!oficioDoc.exists()) {
      console.log(`Oficio ${oficioId} not found, skipping deletion.`);
      return; // Already deleted
    }
    const oficioData = oficioDoc.data() as Oficio;

    const batch = writeBatch(db);
    
    // 1. Delete comments subcollection
    const commentsPath = `oficios/${oficioId}/comments`;
    const commentsSnapshot = await getDocs(query(collection(db, commentsPath)));
    commentsSnapshot.forEach(doc => batch.delete(doc.ref));

    // 2. Delete the main document
    batch.delete(oficioRef);

    // Commit Firestore deletions
    await batch.commit();

    // 3. Delete associated files from Storage
    const filesToDelete: { path?: string; url?: string; name?: string }[] = [];
    if (oficioData.attachments) filesToDelete.push(...oficioData.attachments);
    if (oficioData.protocoloArquivo) filesToDelete.push(oficioData.protocoloArquivo);
    if (oficioData.respostaArquivo) filesToDelete.push(oficioData.respostaArquivo);
    
    // also get files from comments subcollection
    for(const commentDoc of commentsSnapshot.docs) {
        const commentData = commentDoc.data();
        if (commentData.attachments && Array.isArray(commentData.attachments)) {
            filesToDelete.push(...commentData.attachments);
        }
    }

    for (const file of filesToDelete) {
        if (!file.path) continue;
        try {
            const fileStorageRef = storageRef(storage, file.path);
            await deleteObject(fileStorageRef);
        } catch (error: any) {
            // It's okay if the file doesn't exist, log other errors
            if (error.code !== 'storage/object-not-found') {
                console.warn(`Failed to delete storage file ${file.path}:`, error);
            }
        }
    }
    
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: oficioRef.path, operation: 'delete' });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao excluir permanentemente o ofício.');
  }
}

export async function deleteOficioPdf(
    db: Firestore,
    storage: FirebaseStorage,
    oficioId: string,
    actorUid: string
  ): Promise<void> {
    const oficioRef = doc(db, 'oficios', oficioId);
    const oficioDoc = await getDoc(oficioRef);
  
    if (!oficioDoc.exists()) {
      throw new Error('Ofício não encontrado.');
    }
  
    const oficioData = oficioDoc.data() as Oficio;
    const { pdfPath, status } = oficioData;
  
    if (pdfPath) {
      const fileRef = storageRef(storage, pdfPath);
      try {
        await deleteObject(fileRef);
      } catch (error: any) {
        // It's okay if the file is already gone, just log other errors
        if (error.code !== 'storage/object-not-found') {
          console.warn(`Failed to delete storage file ${pdfPath}:`, error);
        }
      }
    }
  
    const dataToUpdate = {
      pdfUrl: deleteField(),
      pdfPath: deleteField(),
      updatedAt: new Date(),
      eventLog: arrayUnion({
        status: status,
        actorUid: actorUid,
        timestamp: new Date(),
        notes: 'PDF do ofício foi excluído.',
      }),
    };
  
    try {
      await updateDoc(oficioRef, dataToUpdate);
    } catch (error) {
      const permissionError = new FirestorePermissionError({
        path: oficioRef.path,
        operation: 'update',
        requestResourceData: { pdfUrl: null, pdfPath: null },
      });
      errorEmitter.emit('permission-error', permissionError);
      throw new Error('Falha ao excluir o PDF do ofício.');
    }
}

export async function deleteManyOficiosPermanently(db: Firestore, storage: FirebaseStorage, oficioIds: string[]): Promise<void> {
  const deletePromises = oficioIds.map(id => deleteOficioPermanently(db, storage, id));
  
  const results = await Promise.allSettled(deletePromises);

  const failedDeletions = results.filter(result => result.status === 'rejected');

  if (failedDeletions.length > 0) {
    console.error('Some deletions failed:', failedDeletions);
    throw new Error(`Falha ao excluir ${failedDeletions.length} de ${oficioIds.length} ofício(s).`);
  }
}

// UPLOAD TOKEN ACTIONS
export async function createUploadToken(db: Firestore, oficioId: string): Promise<string> {
  const tokenRef = doc(collection(db, 'uploadTokens'));
  const now = new Date();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

  const tokenData = {
      oficioId,
      action: 'protocolo',
      createdAt: now,
      expiresAt: expiresAt,
      used: false,
  };
  
  try {
    await setDoc(tokenRef, tokenData);
    return tokenRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
        path: tokenRef.path,
        operation: 'create',
        requestResourceData: tokenData
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar token de upload.');
  }
}

// OFICIO COMMENT ACTIONS
export async function addCommentToOficio(
  db: Firestore,
  storage: FirebaseStorage,
  oficioId: string,
  user: { uid: string; displayName: string | null },
  text: string,
  files: File[]
) {
  if (!text.trim() && files.length === 0) {
    throw new Error('O comentário não pode estar vazio e sem anexos.');
  }

  let attachmentUrls: { name: string; url: string; path: string; }[] = [];
  if (files.length > 0) {
    try {
      const uploadPromises = files.map((file) =>
        _uploadFile(storage, `oficios/${oficioId}/comments/${Date.now()}-${file.name}`, file)
      );
      attachmentUrls = await Promise.all(uploadPromises);
    } catch (error: any) {
      // Re-throw the user-friendly error from _uploadFile.
      throw error;
    }
  }

  const commentsColRef = collection(db, `oficios/${oficioId}/comments`);
  const commentData = {
    author: user.displayName || user.uid,
    authorUid: user.uid,
    date: new Date(),
    text,
    attachments: attachmentUrls,
  };

  try {
    await addDoc(commentsColRef, commentData);
  } catch (error) {
    // This is a Firestore error, so use the existing permission error system.
    const permissionError = new FirestorePermissionError({
      path: commentsColRef.path,
      operation: 'create',
      requestResourceData: commentData,
    });
    errorEmitter.emit('permission-error', permissionError);
    // Re-throw a user-friendly error.
    throw new Error(
      'Falha ao salvar o comentário. Verifique suas permissões no Firestore.'
    );
  }
}

// REQUERIMENTO ACTIONS
export async function updateRequerimento(
  db: Firestore,
  requerimentoId: string,
  actorUid: string,
  newData: Partial<Omit<Requerimento, 'id' | 'authorUid' | 'createdAt'>>
) {
  const requerimentoRef = doc(db, 'requerimentos', requerimentoId);
  
  try {
    await runTransaction(db, async (transaction) => {
        const reqDoc = await transaction.get(requerimentoRef);
        if (!reqDoc.exists()) {
            throw new Error("Documento não encontrado.");
        }

        const currentData = reqDoc.data() as Requerimento;
        const notes = newData.status
            ? `Status alterado para "${newData.status}"`
            : 'Conteúdo do requerimento foi editado.';
        
        const event = {
            status: newData.status || currentData.status,
            actorUid,
            timestamp: new Date(),
            notes,
        };

        const dataToUpdate = {
            ...newData,
            updatedAt: new Date(),
            eventLog: arrayUnion(event)
        };
        
        transaction.update(requerimentoRef, dataToUpdate);
    });
  } catch (error: any) {
    const permissionError = new FirestorePermissionError({
      path: requerimentoRef.path,
      operation: 'update',
      requestResourceData: newData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error(error.message || 'Falha ao salvar as alterações do requerimento.');
  }
}

// INDICACAO CREATION
export async function createIndicacao(
  db: Firestore,
  actorUid: string,
  values: {
    numero: string;
    ano: number;
    dataIndicacao: string;
    assunto: string;
    destinatario: string;
    corpo: string;
    originalCorpo?: string;
  },
  attachmentUrls: { name: string; url: string; path: string }[]
): Promise<string> {
  const numberingRef = doc(db, 'numbering', `indicacao-${values.ano}`);
  const uniqueRef = doc(db, 'unique_indicacoes', `${values.ano}-${values.numero}`);

  try {
    const newIndicacaoId = await runTransaction(db, async (transaction) => {
      const uniqueDoc = await transaction.get(uniqueRef);
      if (uniqueDoc.exists()) {
        throw new Error(`A indicação número ${values.numero}/${values.ano} já existe.`);
      }

      const numberingDoc = await transaction.get(numberingRef);
      const currentNextNumber = numberingDoc.exists() ? numberingDoc.data().nextNumber || 1 : 1;

      const newIndicacaoRef = doc(collection(db, 'indicacoes'));

      const newIndicacaoData = {
        assunto: values.assunto,
        destinatario: values.destinatario,
        corpo: values.corpo,
        originalCorpo: values.originalCorpo,
        id: newIndicacaoRef.id,
        numero: values.numero,
        ano: values.ano,
        status: 'Rascunho' as const,
        authorUid: actorUid,
        createdAt: new Date(`${values.dataIndicacao}T12:00:00`),
        updatedAt: new Date(),
        attachments: attachmentUrls,
        eventLog: [
          {
            status: 'Rascunho' as const,
            actorUid,
            timestamp: new Date(),
            notes: 'Documento criado',
          },
        ],
      };

      transaction.set(newIndicacaoRef, newIndicacaoData);
      transaction.set(uniqueRef, { indicacaoId: newIndicacaoRef.id });

      if (parseInt(values.numero, 10) >= currentNextNumber) {
        transaction.set(numberingRef, {
          type: 'indicacao',
          year: values.ano,
          nextNumber: parseInt(values.numero, 10) + 1,
        }, { merge: true });
      }

      return newIndicacaoRef.id;
    });

    return newIndicacaoId;
  } catch (error) {
    if (error instanceof Error && error.message.includes('já existe')) {
      throw error;
    }
    console.error("Transaction failed: ", error);
    const permissionError = new FirestorePermissionError({
      path: `indicacoes or numbering/indicacao-${values.ano}`,
      operation: 'write',
      requestResourceData: values
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Não foi possível gerar o número da indicação. A transação falhou, possivelmente devido a um conflito ou problema de permissão. Tente novamente.');
  }
}

export async function updateIndicacao(
  db: Firestore,
  indicacaoId: string,
  actorUid: string,
  newData: Partial<Omit<Indicacao, 'id' | 'authorUid' | 'createdAt'>>
) {
  const indicacaoRef = doc(db, 'indicacoes', indicacaoId);

  try {
    await runTransaction(db, async (transaction) => {
      const indDoc = await transaction.get(indicacaoRef);
      if (!indDoc.exists()) {
        throw new Error("Documento não encontrado.");
      }

      const currentData = indDoc.data() as Indicacao;
      const notes = newData.status
        ? `Status alterado para "${newData.status}"`
        : 'Conteúdo da indicação foi editado.';

      const event = {
        status: newData.status || currentData.status,
        actorUid,
        timestamp: new Date(),
        notes,
      };

      const dataToUpdate = {
        ...newData,
        updatedAt: new Date(),
        eventLog: arrayUnion(event)
      };

      transaction.update(indicacaoRef, dataToUpdate);
    });
  } catch (error: any) {
    const permissionError = new FirestorePermissionError({
      path: indicacaoRef.path,
      operation: 'update',
      requestResourceData: newData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error(error.message || 'Falha ao salvar as alterações da indicação.');
  }
}

// Helper function to get the next Monday
function getNextMonday(date = new Date()) {
    const dateCopy = new Date(date.getTime());
    const nextMonday = new Date(
        dateCopy.setDate(
            dateCopy.getDate() + ((7 - dateCopy.getDay() + 1) % 7 || 7)
        )
    );
    nextMonday.setHours(0,0,0,0);
    return nextMonday;
}

export async function approveRequerimentoForPauta(
  db: Firestore,
  requerimentoId: string,
  actorUid: string,
) {
    const dataPauta = getNextMonday();
    const updates = {
        status: 'Pautado' as const,
        dataPauta: dataPauta,
        pautadoPor: actorUid,
        pautadoEm: new Date(),
    };
    await updateRequerimento(db, requerimentoId, actorUid, updates);
}

export async function addCommentToRequerimento(
  db: Firestore,
  storage: FirebaseStorage,
  requerimentoId: string,
  user: { uid: string; displayName: string | null },
  text: string,
  files: File[]
) {
  if (!text.trim() && files.length === 0) {
    throw new Error('O comentário não pode estar vazio e sem anexos.');
  }

  let attachmentUrls: { name: string; url: string; path: string }[] = [];
  if (files.length > 0) {
    try {
      const uploadPromises = files.map((file) =>
        _uploadFile(storage, `requerimentos/${requerimentoId}/comments/${Date.now()}-${file.name}`, file)
      );
      attachmentUrls = await Promise.all(uploadPromises);
    } catch (error: any) {
      // Re-throw the user-friendly error from _uploadFile.
      throw error;
    }
  }

  const commentsColRef = collection(db, `requerimentos/${requerimentoId}/comments`);
  const commentData = {
    author: user.displayName || user.uid,
    authorUid: user.uid,
    date: new Date(),
    text,
    attachments: attachmentUrls,
  };

  try {
    await addDoc(commentsColRef, commentData);
  } catch (error) {
    // This is a Firestore error, so use the existing permission error system.
    const permissionError = new FirestorePermissionError({
      path: commentsColRef.path,
      operation: 'create',
      requestResourceData: commentData,
    });
    errorEmitter.emit('permission-error', permissionError);
    // Re-throw a user-friendly error.
    throw new Error(
      'Falha ao salvar o comentário. Verifique suas permissões no Firestore.'
    );
  }
}

// RECORTES ACTIONS

export async function createRecorteFolder(db: Firestore, userUid: string, data: { name: string, description: string, isPublic: boolean }): Promise<string> {
  const folderRef = doc(collection(db, 'recortes'));
  const folderData: Omit<RecorteFolder, 'id'> & { id: string } = {
    id: folderRef.id,
    name: data.name,
    description: data.description,
    isPublic: data.isPublic,
    authorUid: userUid,
    createdAt: new Date(),
    accessKey: uuidv4().substring(0, 8), // generate access key on creation
  };

  try {
    await setDoc(folderRef, folderData);
    return folderRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: folderRef.path, operation: 'create', requestResourceData: folderData });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar a pasta de recortes.');
  }
}

/**
 * Apaga uma pasta de recortes POR INTEIRO (sem deixar órfãos):
 *   1) todos os arquivos do Storage sob `recortes/{folderId}/` (vídeos originais,
 *      edições `edited-*`, comprimidos…) — varre com listAll (1 nível + subpastas);
 *   2) todos os docs da subcoleção `recortes/{folderId}/videos` (em lotes);
 *   3) o doc da própria pasta.
 *
 * Antes este delete era "simplificado" e só apagava o doc da pasta — os vídeos
 * ficavam órfãos no Storage (custo acumulando) e os docs de vídeo órfãos no
 * Firestore. A limpeza do Storage é best-effort: se um objeto falhar, segue
 * (não trava a exclusão), mas o doc da pasta só cai por último.
 */
export async function deleteRecorteFolder(db: Firestore, storage: FirebaseStorage, folderId: string): Promise<void> {
  const folderRef = doc(db, 'recortes', folderId);

  // 1) Storage: apaga tudo sob o prefixo da pasta (best-effort).
  if (storage) {
    try {
      const apagarPrefixo = async (prefixo: ReturnType<typeof storageRef>) => {
        const listagem = await listAll(prefixo);
        await Promise.all(listagem.items.map((item) => deleteObject(item).catch(() => {})));
        // subpastas eventuais (1 nível): apaga seus itens também.
        await Promise.all(
          listagem.prefixes.map(async (sub) => {
            const subList = await listAll(sub);
            await Promise.all(subList.items.map((item) => deleteObject(item).catch(() => {})));
          }),
        );
      };
      await apagarPrefixo(storageRef(storage, `recortes/${folderId}`));
    } catch {
      /* limpeza de Storage é best-effort — não impede a exclusão do Firestore */
    }
  }

  // 2) Firestore: apaga os docs da subcoleção `videos` em lotes (<=400/lote).
  try {
    const videosSnap = await getDocs(collection(db, `recortes/${folderId}/videos`));
    const docs = videosSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const lote = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) lote.delete(d.ref);
      await lote.commit();
    }
  } catch {
    /* se a subcoleção não puder ser lida/apagada, segue p/ apagar a pasta */
  }

  // 3) Doc da pasta.
  try {
    await deleteDoc(folderRef);
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: folderRef.path, operation: 'delete' });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao excluir a pasta.');
  }
}

export async function generateRecorteShareLink(db: Firestore, folderId: string): Promise<{ accessKey: string, password?: string }> {
  const folderRef = doc(db, 'recortes', folderId);
  const folderDoc = await getDoc(folderRef);
  if (!folderDoc.exists()) throw new Error('Pasta não encontrada.');

  const folderData = folderDoc.data() as RecorteFolder;
  const accessKey = folderData.accessKey || uuidv4().substring(0, 8);
  let password;

  const dataToUpdate: { accessKey: string, password?: string } = { accessKey };

  if (!folderData.isPublic) {
    password = folderData.password || Math.random().toString(36).slice(-8);
    dataToUpdate.password = password;
  }

  try {
    await updateDoc(folderRef, dataToUpdate);
    return { accessKey, password };
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: folderRef.path, operation: 'update', requestResourceData: dataToUpdate });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao gerar o link de compartilhamento.');
  }
}

export async function uploadRecorteVideo(db: Firestore, storage: FirebaseStorage, folderId: string, uploaderUid: string, file: File, metadata: { name: string, description: string }): Promise<void> {
  const filePath = `recortes/${folderId}/${Date.now()}-${file.name}`;
  const fileRef = storageRef(storage, filePath);

  try {
    // Cache-Control: immutable garante que browser+CDN cacheiem por 1 ano.
    // Como o filePath sempre tem timestamp, nunca há "atualização" do mesmo path.
    await uploadBytes(fileRef, file, {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: file.type || 'video/mp4',
    });

    const videoDocRef = doc(collection(db, `recortes/${folderId}/videos`));
    const videoData: RecorteVideo = {
      id: videoDocRef.id,
      name: metadata.name,
      description: metadata.description,
      filePath: filePath,
      size: file.size,
      createdAt: new Date(),
      uploaderUid: uploaderUid,
    };
    await setDoc(videoDocRef, videoData);
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: `recortes/${folderId}/videos`, operation: 'create' });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha no upload do vídeo.');
  }
}

export async function updateRecorteVideo(db: Firestore, folderId: string, videoId: string, data: { name: string, description: string }): Promise<void> {
  const videoRef = doc(db, `recortes/${folderId}/videos`, videoId);
  try {
    await updateDoc(videoRef, data);
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: videoRef.path, operation: 'update', requestResourceData: data });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao atualizar o vídeo.');
  }
}

export async function deleteRecorteVideo(db: Firestore, storage: FirebaseStorage, folderId: string, video: RecorteVideo): Promise<void> {
  const videoRef = doc(db, `recortes/${folderId}/videos`, video.id);
  const fileRef = storageRef(storage, video.filePath);

  const batch = writeBatch(db);
  batch.delete(videoRef);

  try {
    await deleteObject(fileRef);
    await batch.commit();
  } catch (error) {
    const permissionError = new FirestorePermissionError({ path: videoRef.path, operation: 'delete' });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao excluir o vídeo.');
  }
}

export async function replaceRecorteVideo(
  db: Firestore,
  storage: FirebaseStorage,
  folderId: string,
  videoId: string,
  oldFilePath: string,
  newVideoFile: File,
  actorUid: string
): Promise<void> {
  const newFilePath = `recortes/${folderId}/edited-${Date.now()}-${newVideoFile.name.replace(/ /g, '_')}`;
  
  try {
    // 1. Upload new video — Cache-Control immutable pra CDN+browser cachearem.
    const newFileRef = storageRef(storage, newFilePath);
    await uploadBytes(newFileRef, newVideoFile, {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: newVideoFile.type || 'video/mp4',
    });

    // 2. Update Firestore document
    const videoDocRef = doc(db, `recortes/${folderId}/videos`, videoId);
    await updateDoc(videoDocRef, {
      filePath: newFilePath,
      size: newVideoFile.size,
      compressionJobId: deleteField(), // Clear any existing job ID
      quickEditJobId: deleteField(), // Clear any existing job ID
    });

    // 3. Delete old video file
    const oldFileRef = storageRef(storage, oldFilePath);
    try {
      await deleteObject(oldFileRef);
    } catch (deleteError: any) {
      if (deleteError.code !== 'storage/object-not-found') {
        console.warn(`Failed to delete old video file at ${oldFilePath}:`, deleteError);
      }
    }
  } catch (error: any) {
    const permissionError = new FirestorePermissionError({
      path: `recortes/${folderId}/videos/${videoId}`,
      operation: 'update'
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao substituir o vídeo. Verifique as permissões.');
  }
}

export async function requestVideoCompression(
  db: Firestore,
  folderId: string,
  videoId: string,
  videoFilePath: string,
  originalSize: number,
  settings: { quality: 'low' | 'medium' | 'high'; engine?: 'ffmpeg' | 'transcoder' }
) {
  const videoRef = doc(db, `recortes/${folderId}/videos`, videoId);
  const jobRef = doc(collection(db, 'compressionJobs'));

  // Tier de Cloud Function baseado no tamanho — economia $$ em vídeos pequenos.
  const sizeMB = originalSize / (1024 * 1024);
  const tier: 'small' | 'medium' | 'large' =
    sizeMB <= 100 ? 'small' : sizeMB <= 500 ? 'medium' : 'large';

  // Auto-delete via TTL Firestore: doc apagado 14 dias apos criacao.
  const TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const jobData = {
    videoId,
    folderId,
    videoFilePath,
    status: 'pending' as const,
    quality: settings.quality,
    // CUSTO: Transcoder API desligado (custa ~$0.60/video HD vs ~$0.001 no
    // ffmpeg). Toda compressao roteia pelos tiers ffmpeg small/medium/large,
    // independente do que a UI pediu. Para reativar, volte a `settings.engine ?? 'ffmpeg'`.
    engine: 'ffmpeg' as const,
    tier,
    sourceSize: originalSize,
    requestedAt: new Date(),
    expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
    originalSize: originalSize,
    progress: 0,
  };

  const batch = writeBatch(db);
  batch.set(jobRef, jobData);
  batch.update(videoRef, { compressionJobId: jobRef.id });

  try {
    await batch.commit();
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: `compressionJobs/${jobRef.id} or recortes/${folderId}/videos/${videoId}`,
      operation: 'write',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao solicitar a compressão do vídeo.');
  }
}

export async function requestVideoQuickEdit(
  db: Firestore,
  folderId: string,
  videoId: string,
  settings: QuickEditJob['settings'],
  requestedByUid?: string,
): Promise<string> {
  const videoRef = doc(db, `recortes/${folderId}/videos`, videoId);
  const videoDoc = await getDoc(videoRef);
  if (!videoDoc.exists()) {
    throw new Error("Video document not found.");
  }
  const videoData = videoDoc.data() as RecorteVideo;

  const jobRef = doc(collection(db, 'quickEditJobs'));
  // Auto-delete via TTL Firestore: doc apagado 14 dias apos criacao.
  const TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const jobData: QuickEditJob = {
    id: jobRef.id,
    videoId,
    folderId: folderId,
    videoFilePath: videoData.filePath,
    status: 'pending',
    settings,
    requestedByUid,
    requestedAt: new Date(),
    expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
  };

  const batch = writeBatch(db);
  batch.set(jobRef, jobData);
  // Só vincula o jobId ao vídeo se for replace (afeta o vídeo original);
  // download e new-copy não devem "ocupar" o vídeo original.
  const saveMode = settings.saveMode ?? 'replace';
  if (saveMode === 'replace') {
    batch.update(videoRef, { quickEditJobId: jobRef.id });
  }

  try {
    await batch.commit();
  } catch (error) {
     const permissionError = new FirestorePermissionError({
      path: `quickEditJobs/${jobRef.id} or recortes/${folderId}/videos/${videoId}`,
      operation: 'write',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao solicitar a edição rápida do vídeo.');
  }

  // Devolve o jobId pra que o caller possa registrar no QuickEditJobTracker.
  return jobRef.id;
}


export async function cancelVideoCompression(db: Firestore, folderId: string, videoId: string): Promise<void> {
    const videoRef = doc(db, `recortes/${folderId}/videos`, videoId);
    
    try {
      await runTransaction(db, async (transaction) => {
        // --- ALL READS FIRST ---
        const videoDoc = await transaction.get(videoRef);
        if (!videoDoc.exists()) {
          throw new Error("Vídeo não encontrado.");
        }
        const videoData = videoDoc.data() as RecorteVideo;
        const jobId = videoData.compressionJobId;

        let jobRef: DocumentReference<DocumentData> | null = null;
        let jobDoc: DocumentSnapshot<DocumentData> | null = null;
        if (jobId) {
            jobRef = doc(db, 'compressionJobs', jobId);
            jobDoc = await transaction.get(jobRef);
        }

        // --- ALL WRITES AFTER ---
        
        // Immediately unlink the video from the job
        transaction.update(videoRef, { compressionJobId: deleteField() });

        // If the job exists and is in a cancellable state, mark it as cancelled.
        if (jobRef && jobDoc && jobDoc.exists()) {
            const jobData = jobDoc.data() as CompressionJob;
            if (jobData.status === 'pending' || jobData.status === 'compressing') {
              transaction.update(jobRef, { status: 'cancelled' });
            }
        }
      });
    } catch (error: any) {
        if (error instanceof Error) {
            throw new Error(error.message || 'Falha ao cancelar a compressão.');
        }
      throw new Error('Falha ao cancelar a compressão.');
    }
}

export async function clearFailedCompressionJob(db: Firestore, folderId: string, videoId: string): Promise<void> {
    const videoRef = doc(db, `recortes/${folderId}/videos`, videoId);
    
    try {
      await runTransaction(db, async (transaction) => {
        const videoDoc = await transaction.get(videoRef);
        if (!videoDoc.exists()) {
          throw new Error("Vídeo não encontrado.");
        }
        const videoData = videoDoc.data() as RecorteVideo;
        const jobId = videoData.compressionJobId;

        if (jobId) {
            const jobRef = doc(db, 'compressionJobs', jobId);
            const jobDoc = await transaction.get(jobRef);
            if (jobDoc.exists() && jobDoc.data().status === 'error') {
                 transaction.delete(jobRef);
            }
        }
        
        transaction.update(videoRef, { compressionJobId: deleteField() });
      });
    } catch (error: any) {
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('Falha ao limpar a tarefa de compressão com erro.');
    }
  }

// AGENDA (COMPROMISSO) ACTIONS
export async function createCompromisso(
  db: Firestore,
  actorUid: string,
  values: {
    title: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    location?: string;
  }
): Promise<string> {
  const compromissoRef = doc(collection(db, 'compromissos'));
  
  const newCompromissoData = {
    ...values,
    id: compromissoRef.id,
    authorUid: actorUid,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    await setDoc(compromissoRef, newCompromissoData);
    return compromissoRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: compromissoRef.path,
      operation: 'create',
      requestResourceData: newCompromissoData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar o compromisso.');
  }
}

export async function updateCompromisso(
  db: Firestore,
  compromissoId: string,
  actorUid: string,
  updates: Partial<Omit<Compromisso, 'id' | 'authorUid' | 'createdAt'>>
): Promise<void> {
    const compromissoRef = doc(db, 'compromissos', compromissoId);
    
    const dataToUpdate = {
        ...updates,
        updatedAt: new Date()
    };

    try {
        await updateDoc(compromissoRef, dataToUpdate);
    } catch (error) {
        const permissionError = new FirestorePermissionError({
            path: compromissoRef.path,
            operation: 'update',
            requestResourceData: dataToUpdate,
        });
        errorEmitter.emit('permission-error', permissionError);
        throw new Error('Falha ao atualizar o compromisso.');
    }
}

export async function deleteCompromisso(db: Firestore, compromissoId: string): Promise<void> {
  const compromissoRef = doc(db, 'compromissos', compromissoId);
  try {
    await deleteDoc(compromissoRef);
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: compromissoRef.path,
      operation: 'delete',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao excluir o compromisso.');
  }
}

// TRANSCRIPTION ACTIONS

export async function createTranscriptionGroup(
  db: Firestore,
  actorUid: string,
  name: string,
  fileCount: number
): Promise<string> {
  const groupRef = doc(collection(db, 'transcriptionGroups'));
  const newGroupData = {
    id: groupRef.id,
    name,
    authorUid: actorUid,
    createdAt: new Date(),
    fileCount,
  };
  
  try {
    await setDoc(groupRef, newGroupData);
    return groupRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: groupRef.path,
      operation: 'create',
      requestResourceData: newGroupData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar grupo de transcrição.');
  }
}

export async function createTranscriptionRecord(
  db: Firestore,
  storage: FirebaseStorage,
  actorUid: string,
  audioFile: File,
  transcription: string,
  status: 'completed' | 'error',
  errorMsg?: string,
  groupInfo?: { groupId: string; groupName: string }
): Promise<string> {
  // 1. Upload audio file to storage
  const audioPath = `transcriptions/${actorUid}/${Date.now()}-${audioFile.name}`;
  await _uploadFile(storage, audioPath, audioFile);

  // 2. Create firestore document
  const transcriptionRef = doc(collection(db, 'transcriptions'));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

  const newTranscriptionData = {
    id: transcriptionRef.id,
    name: audioFile.name,
    audioPath: audioPath,
    transcription: transcription,
    status: status,
    error: errorMsg || '',
    createdAt: now,
    expiresAt: expiresAt,
    authorUid: actorUid,
    groupId: groupInfo?.groupId || null,
  };

  try {
    await setDoc(transcriptionRef, newTranscriptionData);
    return transcriptionRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: transcriptionRef.path,
      operation: 'create',
      requestResourceData: newTranscriptionData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao salvar o registro da transcrição.');
  }
}

export async function deleteTranscription(
  db: Firestore,
  storage: FirebaseStorage,
  transcriptionId: string
): Promise<void> {
  const transcriptionRef = doc(db, 'transcriptions', transcriptionId);

  try {
    const docSnap = await getDoc(transcriptionRef);
    if (!docSnap.exists()) {
      console.warn(`Transcription ${transcriptionId} not found, skipping deletion.`);
      return;
    }
    const transcriptionData = docSnap.data();

    // Delete Firestore document
    await deleteDoc(transcriptionRef);

    // Delete Storage file
    if (transcriptionData.audioPath) {
      const fileRef = storageRef(storage, transcriptionData.audioPath);
      try {
        await deleteObject(fileRef);
      } catch (storageError: any) {
        if (storageError.code !== 'storage/object-not-found') {
          console.error(`Failed to delete storage file ${transcriptionData.audioPath}:`, storageError);
          // Don't re-throw, just log, as the Firestore doc is already gone.
        }
      }
    }
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: transcriptionRef.path,
      operation: 'delete',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao excluir a transcrição.');
  }
}

export async function deleteTranscriptionGroup(db: Firestore, storage: FirebaseStorage, groupId: string): Promise<void> {
    const groupRef = doc(db, 'transcriptionGroups', groupId);
    const transcriptionsQuery = query(collection(db, 'transcriptions'), where('groupId', '==', groupId));

    try {
        const transcriptionsSnapshot = await getDocs(transcriptionsQuery);
        
        const batch = writeBatch(db);

        // Delete all transcriptions in the group
        const storagePathsToDelete: string[] = [];
        transcriptionsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
            const data = doc.data() as Transcription;
            if (data.audioPath) {
                storagePathsToDelete.push(data.audioPath);
            }
        });

        // Delete the group document itself
        batch.delete(groupRef);

        // Commit all Firestore deletions
        await batch.commit();

        // Delete all associated files from Storage
        for (const path of storagePathsToDelete) {
            const fileRef = storageRef(storage, path);
            try {
                await deleteObject(fileRef);
            } catch (storageError: any) {
                if (storageError.code !== 'storage/object-not-found') {
                    console.warn(`Failed to delete storage file ${path}:`, storageError);
                }
            }
        }
    } catch(error) {
        const permissionError = new FirestorePermissionError({ path: `transcriptionGroups/${groupId}`, operation: 'delete' });
        errorEmitter.emit('permission-error', permissionError);
        throw new Error('Falha ao excluir o grupo de transcrições.');
    }
}

// DATA MANAGEMENT ACTIONS
export async function clearCollection(db: Firestore, collectionName: string): Promise<number> {
  // Allowlist defensiva: só as coleções de jobs de vídeo podem ser limpas em
  // massa pela tela de manutenção (únicos nomes que a UI passa hoje). Evita que
  // a função vire vetor para apagar coleções de negócio.
  const ALLOWED_COLLECTIONS = ['compressionJobs', 'quickEditJobs'];
  if (!ALLOWED_COLLECTIONS.includes(collectionName)) {
    throw new Error(`Coleção '${collectionName}' não é permitida para limpeza em massa.`);
  }
  const collectionRef = collection(db, collectionName);
  let deletedCount = 0;
  
  try {
    const querySnapshot = await getDocs(collectionRef);
    
    if (querySnapshot.empty) {
      return 0;
    }

    // Firestore allows up to 500 operations in a single batch
    const batchSize = 500;
    for (let i = 0; i < querySnapshot.docs.length; i += batchSize) {
      const batch = writeBatch(db);
      const chunk = querySnapshot.docs.slice(i, i + batchSize);
      chunk.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      deletedCount += chunk.length;
    }
    return deletedCount;

  } catch (error: any) {
    // We can't use the permission error emitter here easily because we don't know the exact failed operation context.
    // Throwing a generic error is sufficient for the UI toast.
    console.error(`Failed to clear collection ${collectionName}:`, error);
    throw new Error('Falha ao limpar a coleção. Verifique as permissões de exclusão no Firestore.');
  }
}

export async function clearExpiredUploadTokens(db: Firestore): Promise<number> {
  const tokensRef = collection(db, 'uploadTokens');
  const now = new Date();
  
  // Query for expired tokens
  const expiredQuery = query(tokensRef, where('expiresAt', '<', now));
  // Query for used tokens that might not be expired yet
  const usedQuery = query(tokensRef, where('used', '==', true));

  try {
    const [expiredSnapshot, usedSnapshot] = await Promise.all([
        getDocs(expiredQuery),
        getDocs(usedQuery)
    ]);
    
    const docsToDelete = new Map<string, DocumentSnapshot>();
    expiredSnapshot.forEach(doc => docsToDelete.set(doc.id, doc));
    usedSnapshot.forEach(doc => docsToDelete.set(doc.id, doc));

    if (docsToDelete.size === 0) {
      return 0;
    }

    // Firestore allows up to 500 operations in a single batch
    const batchSize = 500;
    const docArray = Array.from(docsToDelete.values());
    let deletedCount = 0;
    
    for (let i = 0; i < docArray.length; i += batchSize) {
      const batch = writeBatch(db);
      const chunk = docArray.slice(i, i + batchSize);
      chunk.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      deletedCount += chunk.length;
    }

    return deletedCount;

  } catch (error: any) {
    console.error(`Failed to clear expired tokens:`, error);
    const permissionError = new FirestorePermissionError({
      path: tokensRef.path,
      operation: 'delete',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao limpar tokens de upload. Verifique as permissões de exclusão no Firestore.');
  }
}

// PROJETO DE LEI ACTIONS
export async function createProjetoDeLei(
  db: Firestore,
  actorUid: string,
  values: { proposta: string },
  attachmentUrls: { name: string; url: string; path: string }[]
): Promise<string> {
  const projetoRef = doc(collection(db, 'projetos-de-lei'));
  
  const newProjetoData: Omit<ProjetoDeLei, 'id' | 'updatedAt' | 'createdAt'> = {
    proposta: values.proposta,
    ano: new Date().getFullYear(),
    status: 'Proposta',
    authorUid: actorUid,
    attachments: attachmentUrls,
    eventLog: [
      {
        status: 'Proposta',
        actorUid: actorUid,
        timestamp: new Date(),
        notes: 'Criação da proposta de projeto de lei.',
      },
    ],
  };

  try {
    await setDoc(projetoRef, {
        ...newProjetoData,
        id: projetoRef.id,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
    return projetoRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: projetoRef.path,
      operation: 'create',
      requestResourceData: newProjetoData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar o projeto de lei.');
  }
}


export async function updateProjetoDeLei(
  db: Firestore,
  projetoId: string,
  actorUid: string,
  newData: Partial<Omit<ProjetoDeLei, 'id' | 'authorUid' | 'createdAt'>>,
  customNotes?: string
) {
  const projetoRef = doc(db, 'projetos-de-lei', projetoId);
  
  try {
    const projDoc = await getDoc(projetoRef);
    if (!projDoc.exists()) {
        throw new Error("Documento não encontrado.");
    }
    const currentData = projDoc.data() as ProjetoDeLei;

    let notes = customNotes || 'Projeto de lei atualizado.';
    if (newData.status && newData.status !== currentData.status && !customNotes) {
        notes = `Status alterado para "${newData.status}"`;
    }
    
    const event = {
        status: newData.status || currentData.status,
        actorUid,
        timestamp: new Date(),
        notes,
    };

    const dataToUpdate = {
        ...newData,
        updatedAt: new Date(),
        eventLog: arrayUnion(event)
    };
    
    await updateDoc(projetoRef, dataToUpdate);

  } catch (error: any) {
    const permissionError = new FirestorePermissionError({
      path: projetoRef.path,
      operation: 'update',
      requestResourceData: newData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error(error.message || 'Falha ao salvar as alterações do projeto de lei.');
  }
}

export async function addViabilityStudyToProjeto(
  db: Firestore,
  projetoId: string,
  actorUid: string,
  study: { title: string, content: string }
) {
  const projetoRef = doc(db, 'projetos-de-lei', projetoId);
  
  const projDoc = await getDoc(projetoRef);
  if (!projDoc.exists()) {
    throw new Error("Projeto de Lei não encontrado.");
  }
  const currentStatus = projDoc.data().status;

  const newStudy: ViabilityStudy = {
    ...study,
    id: uuidv4(),
    createdAt: new Date(),
    actorUid: actorUid,
  };

  try {
    await updateDoc(projetoRef, {
      estudosDeViabilidade: arrayUnion(newStudy),
      updatedAt: new Date(),
      eventLog: arrayUnion({
        status: currentStatus,
        actorUid: actorUid,
        timestamp: new Date(),
        notes: `Novo estudo de viabilidade gerado: "${study.title}"`,
      }),
    });
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: projetoRef.path,
      operation: 'update',
      requestResourceData: { estudosDeViabilidade: '...' },
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao adicionar o estudo de viabilidade.');
  }
}

export async function deleteViabilityStudyFromProjeto(
  db: Firestore,
  projetoId: string,
  studyId: string,
  actorUid: string
) {
  const projetoRef = doc(db, 'projetos-de-lei', projetoId);

  try {
    await runTransaction(db, async (transaction) => {
      const projDoc = await transaction.get(projetoRef);
      if (!projDoc.exists()) {
        throw new Error('Projeto de Lei não encontrado.');
      }

      const projetoData = projDoc.data() as ProjetoDeLei;
      const studies = projetoData.estudosDeViabilidade || [];
      const studyToDelete = studies.find(s => s.id === studyId);
      const updatedStudies = studies.filter(s => s.id !== studyId);

      transaction.update(projetoRef, {
        estudosDeViabilidade: updatedStudies,
        updatedAt: new Date(),
        eventLog: arrayUnion({
          status: projetoData.status,
          actorUid: actorUid,
          timestamp: new Date(),
          notes: `Estudo de viabilidade removido: "${studyToDelete?.title || studyId}"`,
        }),
      });
    });
  } catch (error: any) {
    const permissionError = new FirestorePermissionError({
      path: projetoRef.path,
      operation: 'update',
      requestResourceData: { estudosDeViabilidade: '...' },
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error(error.message || 'Falha ao remover o estudo de viabilidade.');
  }
}

export async function addLegalAnalysisToProjeto(
  db: Firestore,
  projetoId: string,
  actorUid: string,
  analysis: { title: string, content: string }
) {
  const projetoRef = doc(db, 'projetos-de-lei', projetoId);

  const projDoc = await getDoc(projetoRef);
  if (!projDoc.exists()) {
    throw new Error("Projeto de Lei não encontrado.");
  }
  const currentStatus = projDoc.data().status;

  const newAnalysis: ViabilityStudy = { // Reusing ViabilityStudy type for simplicity
    ...analysis,
    id: uuidv4(),
    createdAt: new Date(),
    actorUid: actorUid,
  };

  try {
    await updateDoc(projetoRef, {
      analiseJuridica: arrayUnion(newAnalysis),
      updatedAt: new Date(),
      eventLog: arrayUnion({
        status: currentStatus,
        actorUid: actorUid,
        timestamp: new Date(),
        notes: `Nova análise jurídica gerada: "${analysis.title}"`,
      }),
    });
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: projetoRef.path,
      operation: 'update',
      requestResourceData: { analiseJuridica: '...' },
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao adicionar a análise jurídica.');
  }
}


export async function uploadAiKnowledgeBase(db: Firestore, storage: FirebaseStorage, file: File): Promise<void> {
  const filePath = 'configs/ai/knowledge_base.json';
  const fileRef = storageRef(storage, filePath);
  
  try {
    // Overwrite the existing file in storage
    await uploadBytes(fileRef, file);

    // Update the path in Firestore
    const configRef = doc(db, 'configs', 'main');
    const data = { aiKnowledgeBaseUrl: filePath };
    
    await setDoc(configRef, data, { merge: true });

  } catch (error: any) {
    const configRef = doc(db, 'configs', 'main');
    const permissionError = new FirestorePermissionError({
      path: configRef.path,
      operation: 'write',
      requestResourceData: { aiKnowledgeBaseUrl: filePath }
    });
    errorEmitter.emit('permission-error', permissionError);
    
    // Also consider storage errors
    if (error.code && error.code.startsWith('storage/')) {
        throw new Error('Falha ao enviar o arquivo para o Firebase Storage. Verifique suas regras de segurança.');
    }

    throw new Error('Não foi possível salvar a base de conhecimento.');
  }
}

// OFICIO IMPORT ACTIONS
export async function revertOficioImports(db: Firestore, logIds: string[], actorUid: string) {
    const batch = writeBatch(db);
    for (const logId of logIds) {
        const logRef = doc(db, 'oficio-import-logs', logId);
        const logDoc = await getDoc(logRef);
        if (logDoc.exists()) {
            const logData = logDoc.data() as OficioImportLog;
            if (logData.status === 'imported') {
                const oficioRef = doc(db, 'oficios', logData.oficioId);
                batch.delete(oficioRef);
                batch.update(logRef, { status: 'reverted', revertedAt: new Date(), revertedBy: actorUid });
            }
        }
    }
    try {
        await batch.commit();
    } catch(e: any) {
        throw new Error(`Falha ao reverter importações: ${e.message}`);
    }
}

export async function reImportOficio(db: Firestore, logId: string, actorUid: string) {
  const logRef = doc(db, 'oficio-import-logs', logId);
  const logDoc = await getDoc(logRef);

  if (!logDoc.exists() || logDoc.data().status !== 'reverted') {
    throw new Error('Este registro de importação não é válido ou não foi revertido.');
  }

  const importData = logDoc.data().importData;

  // We are not handling file re-upload here, this just re-creates the document from logged data
  const newOficioId = await createOficio(db, actorUid, {
    numero: importData.numero,
    ano: importData.ano,
    dataOficio: importData.dataOficio,
    destinatario: importData.destinatario,
    cargoDestinatario: importData.cargoDestinatario,
    vocativo: importData.vocativo,
    assunto: importData.assunto,
    corpo: importData.corpo,
  }, [], []);

  // Update the log to reflect the new import
  const newLogRef = doc(collection(db, 'oficio-import-logs'));
  await setDoc(newLogRef, {
      ...logDoc.data(),
      id: newLogRef.id,
      oficioId: newOficioId,
      status: 'imported',
      importedAt: new Date(),
      actorUid: actorUid,
      revertedAt: deleteField(),
      revertedBy: deleteField(),
  });
  
  // Optionally, you might want to delete the old "reverted" log entry
  await deleteDoc(logRef);
}


// OFICIO IMPORT BATCH ACTIONS

export async function createImportBatch(
  db: Firestore,
  storage: FirebaseStorage,
  userId: string,
  files: File[]
): Promise<string> {
  const batchRef = doc(collection(db, 'importBatches'));

  const uploadPromises = files.map(async (file) => {
    const storagePath = `import-batches/${batchRef.id}/${file.name}`;
    await _uploadFile(storage, storagePath, file);
    return {
      fileName: file.name,
      storagePath,
      status: 'pending' as const,
    };
  });

  const uploadResults = await Promise.allSettled(uploadPromises);
  const filesForFirestore = uploadResults
    .filter((r): r is PromiseFulfilledResult<{ fileName: string; storagePath: string; status: 'pending' }> => r.status === 'fulfilled')
    .map(r => r.value);

  if (filesForFirestore.length === 0) {
    throw new Error('Nenhum arquivo foi enviado com sucesso. Verifique sua conexão e tente novamente.');
  }

  const batchData: Omit<ImportBatch, 'id'> = {
    userId,
    createdAt: new Date() as any,
    status: 'pending',
    files: filesForFirestore,
  };

  try {
    await setDoc(batchRef, { ...batchData, id: batchRef.id });
    return batchRef.id;
  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: batchRef.path,
      operation: 'create',
      requestResourceData: batchData,
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao criar o lote de importação.');
  }
}

export async function updateBatchFileStatus(
  db: Firestore,
  batchId: string,
  storagePath: string,
  updates: Partial<ImportBatchFile>
) {
  const batchRef = doc(db, 'importBatches', batchId);
  try {
    await runTransaction(db, async (transaction) => {
      const batchDoc = await transaction.get(batchRef);
      if (!batchDoc.exists()) {
        throw new Error('Lote de importação não encontrado.');
      }
      const batchData = batchDoc.data() as ImportBatch;
      const fileIndex = batchData.files.findIndex(f => f.storagePath === storagePath);

      if (fileIndex === -1) {
        throw new Error(`Arquivo com o caminho ${storagePath} não encontrado no lote.`);
      }

      const updatedFiles = [...batchData.files];
      updatedFiles[fileIndex] = { ...updatedFiles[fileIndex], ...updates };

      transaction.update(batchRef, { files: updatedFiles });
    });
  } catch (error: any) {
     const permissionError = new FirestorePermissionError({
      path: batchRef.path,
      operation: 'update',
      requestResourceData: { files: '...' }
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error(error.message || 'Falha ao atualizar o status do arquivo no lote.');
  }
}

export async function cleanupBatch(db: Firestore, storage: FirebaseStorage, batchId: string) {
  const batchRef = doc(db, 'importBatches', batchId);
  try {
    const batchDoc = await getDoc(batchRef);
    if (!batchDoc.exists()) {
      return; // Already deleted or never existed.
    }
    const batchData = batchDoc.data() as ImportBatch;

    // Delete all associated files from Storage
    const deletePromises = batchData.files.map(file => {
      const fileRef = storageRef(storage, file.storagePath);
      return deleteObject(fileRef).catch(err => {
        // It's okay if the file is already gone, just log other errors.
        if (err.code !== 'storage/object-not-found') {
          console.warn(`Failed to delete temporary file ${file.storagePath}:`, err);
        }
      });
    });
    await Promise.all(deletePromises);

    // Delete the Firestore document
    await deleteDoc(batchRef);

  } catch (error) {
    const permissionError = new FirestorePermissionError({
      path: batchRef.path,
      operation: 'delete',
    });
    errorEmitter.emit('permission-error', permissionError);
    throw new Error('Falha ao cancelar e limpar o lote de importação.');
  }
}


// =====================================================================
// CAPTION GENERATION (IA) — Suite Editor de Vídeos
// =====================================================================

/**
 * Solicita a geração de legendas via IA para um `VideoProject`.
 *
 * Cria um doc em `captionJobs/{jobId}` que dispara a Cloud Function
 * `onCaptionGenerateRequest`. Se `mixedAudioBlob` for fornecido (cliente
 * já mixou via Web Audio API), faz upload para Storage e cria o job
 * com `mixedAudioPath` preenchido + `needsServerMix: false`. Caso
 * contrário, marca `needsServerMix: true` e a Cloud Function se
 * encarregará de baixar os assets e mixar via FFmpeg.
 *
 * @returns o `jobId` criado (use para `onSnapshot` e tracking de progresso).
 */
export async function requestCaptionGeneration(
  firestore: Firestore,
  storage: FirebaseStorage,
  uid: string,
  projectId: string,
  options: {
    language: string;
    model: 'gemini-2.5-flash' | 'gemini-2.5-pro';
    mixedAudioBlob?: Blob;
  }
): Promise<string> {
  if (!uid) throw new Error('Usuário não autenticado.');
  if (!projectId) throw new Error('projectId é obrigatório.');

  // 1. Reserva o jobRef antes para usar o id no path do Storage.
  const jobRef = doc(collection(firestore, 'captionJobs'));
  const jobId = jobRef.id;

  let mixedAudioPath: string | undefined;
  if (options.mixedAudioBlob) {
    // Mix client agora exporta WAV (substituiu MP3/lamejs que tinha bug).
    const blobType = options.mixedAudioBlob.type || 'audio/wav';
    const ext = blobType.includes('wav') ? 'wav' : 'mp3';
    mixedAudioPath = `captionJobs/${uid}/${jobId}/mixed.${ext}`;
    const fileRef = storageRef(storage, mixedAudioPath);
    try {
      await uploadBytes(fileRef, options.mixedAudioBlob, {
        contentType: blobType,
      });
    } catch (err) {
      console.error('[requestCaptionGeneration] upload do áudio mixado falhou:', err);
      throw new Error(
        'Falha ao enviar o áudio mixado. Verifique CORS e regras de Storage.'
      );
    }
  }

  const jobData: Record<string, unknown> = {
    id: jobId,
    projectId,
    ownerUid: uid,
    status: 'pending',
    language: options.language,
    model: options.model,
    needsServerMix: !mixedAudioPath,
    progress: 0,
    createdAt: new Date(),
  };
  if (mixedAudioPath) {
    jobData.mixedAudioPath = mixedAudioPath;
  }

  try {
    await setDoc(jobRef, jobData);
  } catch (err) {
    const permissionError = new FirestorePermissionError({
      path: jobRef.path,
      operation: 'create',
      requestResourceData: jobData,
    });
    errorEmitter.emit('permission-error', permissionError);
    console.error('[requestCaptionGeneration] criação do job falhou:', err);
    throw new Error('Falha ao solicitar a geração de legendas.');
  }

  return jobId;
}

/**
 * Dispara o parser da LOA (Lei Orçamentária Anual).
 * Wrapper sobre a Cloud Function HTTPS callable `onLoaParseRequest`.
 *
 * Pré-requisitos:
 *  - O PDF da LOA já está no Storage no caminho `pdfPath` (geralmente
 *    `loa/{ano}.pdf`); o upload é feito previamente via UI.
 *  - O usuário precisa ter custom claim de admin.
 *
 * Retorna estatísticas: códigos processados, erros e duplicados pulados.
 * O `timeoutSeconds: 540` é honrado server-side; aqui só esperamos a
 * resposta. Em caso de timeout do callable client-side (HTTPS), o front
 * deve mostrar UX de "processando em background" — o doc do Firestore
 * ainda assim é gravado em batches.
 */
export async function requestLoaParse(
  pdfPath: string,
  ano: number,
  source?: string
): Promise<{ processed: number; errors: number; skipped: number }> {
  if (!pdfPath) throw new Error('pdfPath é obrigatório.');
  if (!Number.isInteger(ano) || ano < 2000) throw new Error('Ano inválido.');

  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<
    { pdfPath: string; ano: number; source?: string },
    { processed: number; errors: number; skipped: number }
  >(functions, 'onLoaParseRequest');

  try {
    const result = await callable({ pdfPath, ano, source });
    return result.data;
  } catch (err: any) {
    console.error('[requestLoaParse] callable falhou:', err);
    const msg =
      err?.message ||
      'Falha ao iniciar o parser da LOA. Verifique se você é admin e se o PDF está acessível.';
    throw new Error(msg);
  }
}


// ============================================================================
// Diário Oficial · Backfill histórico via Querido Diário
// ============================================================================

/**
 * Cria um novo job de backfill em `diarioBackfillJobs`. O job já nasce
 * em `running` para que a Cloud Function `onDiarioBackfillJob` comece a
 * processar imediatamente.
 *
 * @returns jobId criado.
 */
export async function requestDiarioBackfill(
  firestore: Firestore,
  uid: string,
  options: { startDate: string; endDate?: string }
): Promise<string> {
  if (!uid) throw new Error('Usuário não autenticado.');
  if (!options.startDate) throw new Error('startDate é obrigatório (YYYY-MM-DD).');

  const today = new Date().toISOString().slice(0, 10);
  const endDate = options.endDate ?? today;

  // Validações simples de formato.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoRe.test(options.startDate)) {
    throw new Error('startDate deve estar em formato YYYY-MM-DD.');
  }
  if (!isoRe.test(endDate)) {
    throw new Error('endDate deve estar em formato YYYY-MM-DD.');
  }
  if (options.startDate > endDate) {
    throw new Error('startDate não pode ser posterior a endDate.');
  }

  const jobRef = doc(collection(firestore, 'diarioBackfillJobs'));
  const jobId = jobRef.id;

  const jobData = {
    id: jobId,
    startDate: options.startDate,
    endDate,
    status: 'running' as const,
    totalEditions: 0,
    processedEditions: 0,
    skippedEditions: 0,
    errorEditions: 0,
    progress: 0,
    ownerUid: uid,
    createdAt: new Date(),
  };

  try {
    await setDoc(jobRef, jobData);
  } catch (err) {
    const permissionError = new FirestorePermissionError({
      path: jobRef.path,
      operation: 'create',
      requestResourceData: jobData,
    });
    errorEmitter.emit('permission-error', permissionError);
    console.error('[requestDiarioBackfill] criação do job falhou:', err);
    throw new Error('Falha ao iniciar o backfill do Diário Oficial.');
  }

  return jobId;
}

/**
 * Backfill DIRETO via API Dados Abertos da Prefeitura — busca todas as
 * edições do(s) ano(s) em uma única chamada por ano. MUITO mais rápido
 * que o backfill via Querido Diário porque não baixa PDF e não respeita
 * rate-limit (API municipal). Cada edição vira `pending_parse` e segue
 * o fluxo normal.
 *
 * @returns stats por ano + total
 */
export async function requestDiarioBackfillDirect(
  anos: number[],
): Promise<{
  totals: { total: number; novos: number; atualizados: number; skipped: number; errors: number };
  byYear: Record<number, { total: number; novos: number; atualizados: number; skipped: number; errors: number }>;
}> {
  if (!Array.isArray(anos) || anos.length === 0) {
    throw new Error('Informe ao menos um ano.');
  }
  for (const a of anos) {
    if (!Number.isInteger(a) || a < 2009 || a > 2100) {
      throw new Error(`Ano inválido: ${a}.`);
    }
  }

  const { getApp } = await import('firebase/app');
  const callable = httpsCallable<
    { anos: number[] },
    {
      totals: { total: number; novos: number; atualizados: number; skipped: number; errors: number };
      byYear: Record<number, { total: number; novos: number; atualizados: number; skipped: number; errors: number }>;
    }
  >(getFunctions(getApp(), 'us-central1'), 'onDiarioBackfillDirect');
  const res = await callable({ anos });
  return res.data;
}

/** Pausa um backfill em andamento. A function detecta e sai cooperativamente. */
export async function pauseDiarioBackfill(
  firestore: Firestore,
  jobId: string
): Promise<void> {
  if (!jobId) throw new Error('jobId é obrigatório.');
  const jobRef = doc(firestore, 'diarioBackfillJobs', jobId);
  const data = { status: 'paused' as const };
  try {
    await updateDoc(jobRef, data);
  } catch (err) {
    const permissionError = new FirestorePermissionError({
      path: jobRef.path,
      operation: 'update',
      requestResourceData: data,
    });
    errorEmitter.emit('permission-error', permissionError);
    console.error('[pauseDiarioBackfill] falhou:', err);
    throw new Error('Falha ao pausar o backfill.');
  }
}

/**
 * Retoma um backfill pausado/erro/cancelado. Ao mudar status para
 * `running`, a Cloud Function dispara um novo ciclo, idempotente.
 */
export async function resumeDiarioBackfill(
  firestore: Firestore,
  jobId: string
): Promise<void> {
  if (!jobId) throw new Error('jobId é obrigatório.');
  const jobRef = doc(firestore, 'diarioBackfillJobs', jobId);
  const data = { status: 'running' as const };
  try {
    await updateDoc(jobRef, data);
  } catch (err) {
    const permissionError = new FirestorePermissionError({
      path: jobRef.path,
      operation: 'update',
      requestResourceData: data,
    });
    errorEmitter.emit('permission-error', permissionError);
    console.error('[resumeDiarioBackfill] falhou:', err);
    throw new Error('Falha ao retomar o backfill.');
  }
}

/** Cancela definitivamente um backfill. */
export async function cancelDiarioBackfill(
  firestore: Firestore,
  jobId: string
): Promise<void> {
  if (!jobId) throw new Error('jobId é obrigatório.');
  const jobRef = doc(firestore, 'diarioBackfillJobs', jobId);
  const data = { status: 'cancelled' as const };
  try {
    await updateDoc(jobRef, data);
  } catch (err) {
    const permissionError = new FirestorePermissionError({
      path: jobRef.path,
      operation: 'update',
      requestResourceData: data,
    });
    errorEmitter.emit('permission-error', permissionError);
    console.error('[cancelDiarioBackfill] falhou:', err);
    throw new Error('Falha ao cancelar o backfill.');
  }
}
