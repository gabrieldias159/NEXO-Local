/**
 * Barrel: persistência Firestore + upload de assets do Suite Editor.
 */

export {
  serializeProjectForFirestore,
  deserializeProjectFromFirestore,
} from './project-serializer';

export {
  saveProject,
  loadProject,
  listUserProjects,
  deleteProject,
  createNewProject,
} from './project-repository';

export {
  uploadAsset,
  uploadAssets,
  type UploadAssetResult,
} from './asset-uploader';

export { useAutoSave } from './use-auto-save';
