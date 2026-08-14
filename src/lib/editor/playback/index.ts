/**
 * Barrel exports do playback engine (vídeo + áudio).
 *
 * Use:
 *  - `createVideoSyncManager` / `createAudioMixer` para uso programático
 *    (testes, render headless).
 *  - `useVideoSync` / `useAudioMixer` em componentes React (cuidam do
 *    singleton + subscribe ao store).
 */
export {
  createVideoSyncManager,
  type VideoSyncManager,
  type CreateVideoSyncManagerOpts,
} from './video-sync';

export {
  useVideoSync,
  getVideoSyncManager,
  type UseVideoSyncResult,
} from './use-video-sync';

export { createAudioMixer, type AudioMixer } from './audio-mixer';

export { useAudioMixer, type UseAudioMixerResult } from './use-audio-mixer';
