/**
 * Barrel export dos layers de preview.
 *
 * Cada layer encapsula a renderização de UM clip + asset, e cuida do seu
 * próprio registro nos engines de playback (vídeo e áudio).
 */

export { VideoLayer } from './VideoLayer';
export { ImageLayer } from './ImageLayer';
