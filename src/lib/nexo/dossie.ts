/**
 * Montagem de dossiês de investigação a partir dos alertas do motor de
 * detecção — empacota o achado com a minuta de requerimento sugerida.
 */
import type { AlertaDetectado } from './detectores';
import {
  modeloParaDetector,
  gerarTextoRequerimento,
  type RequerimentoModelo,
} from './requerimentos';

export interface Dossie {
  alerta: AlertaDetectado;
  modelo: RequerimentoModelo | null;
  /** Minuta de requerimento pronta para o gabinete adaptar. */
  textoRequerimento: string;
}

export function montarDossie(alerta: AlertaDetectado): Dossie {
  const modelo = modeloParaDetector(alerta.detectorId);
  return {
    alerta,
    modelo,
    textoRequerimento: modelo ? gerarTextoRequerimento(alerta, modelo) : '',
  };
}
