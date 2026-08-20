/**
 * Verificador PRÉ-EXPORT (recurso 10 do fluxo do gabinete).
 *
 * Checagens automáticas antes de renderizar — os erros que já custaram
 * retrabalho na produção real. Nenhuma checagem BLOQUEIA o export: a lista
 * aparece no diálogo de exportação para decisão humana.
 *
 * Regras (da spec + regras duras do dono):
 *  - a duração final não pode passar do fim da BASE (nada alonga a fala);
 *  - flash de base <0,5s entre overlays vizinhos (buraco curto entre
 *    criativos pisca o vídeo cru — ou fecha o buraco, ou espaça de vez);
 *  - overlay opaco de tela cheia deve ficar ≤3s (a voz nunca fica coberta);
 *  - legenda estourando a largura da caixa (estimativa por contagem de
 *    caracteres — heurística);
 *  - mídia importada e não usada em nenhum clip (ex.: imagem colada e
 *    esquecida);
 *  - asset ainda subindo/erro (o render server ignora ou falha);
 *  - legendas sobrepostas no tempo.
 *
 * Puro (sem React) — testável e utilizável fora do diálogo.
 */

import { CUE_GAP_MIN } from './captions/utils';
import type { MediaAsset, VideoProject } from './types';

export type PreflightSeverity = 'erro' | 'aviso';

export interface PreflightIssue {
  severity: PreflightSeverity;
  /** Código estável (útil p/ testes e supressões futuras). */
  code: string;
  /** Mensagem pt-BR pronta para a UI. */
  message: string;
  /** Instante relevante na timeline (s), quando aplicável. */
  at?: number;
}

/** Fração média da altura da fonte que um caractere ocupa (heurística). */
const CHAR_WIDTH_RATIO = 0.58;

/**
 * Só as tracks bastam para as regras de flash/overlay — assim a régua da
 * timeline chama sem montar um `VideoProject` inteiro.
 */
type ProjetoComTracks = Pick<VideoProject, 'tracks'>;

/** Duração máxima do buraco que ainda "pisca" (segundos). */
export const FLASH_MAX_GAP = 0.5;
/** Buracos menores que isto são encostados, não piscam. */
const FLASH_MIN_GAP = 0.02;

export interface FlashDeBase {
  /** Instante do buraco na timeline (fim do overlay anterior). */
  at: number;
  /** Tamanho do buraco em segundos. */
  gap: number;
}

/**
 * Track de BASE: a track de vídeo de menor `index` que tem clips — é a faixa
 * da fala do vereador no fluxo do gabinete.
 */
export function baseTrackOf(project: ProjetoComTracks) {
  return [...project.tracks]
    .filter((t) => t.type === 'video' && t.clips.length > 0)
    .sort((a, b) => a.index - b.index)[0];
}

/**
 * OVERLAYS = clips visuais fora da camada 0 da base (camadas de cima e tracks
 * de vídeo acima), em ordem cronológica.
 */
export function overlayClips(project: ProjetoComTracks) {
  const base = baseTrackOf(project);
  return project.tracks
    .filter((t) => t.type === 'video')
    .flatMap((t) =>
      t.clips.filter(
        (c) => !c.hidden && !(t.id === base?.id && (c.layer ?? 0) === 0),
      ),
    )
    .sort((a, b) => a.startInTimeline - b.startInTimeline);
}

/**
 * FLASH DE BASE (recurso 18): buraco curto (<0,5 s) entre dois overlays
 * vizinhos — a base aparece por um instante e o vídeo "pisca". Regra dura do
 * dono: ou fecha o buraco, ou espaça de vez.
 *
 * Puro e barato — a régua da timeline chama isto a cada mudança do projeto
 * para desenhar os avisos AO VIVO, e o verificador pré-export usa o mesmo
 * cálculo (uma regra só, dois lugares).
 */
export function detectFlashes(project: ProjetoComTracks): FlashDeBase[] {
  const overlays = overlayClips(project);
  const out: FlashDeBase[] = [];
  for (let i = 0; i + 1 < overlays.length; i += 1) {
    const gap = overlays[i + 1].startInTimeline - overlays[i].endInTimeline;
    if (gap > FLASH_MIN_GAP && gap < FLASH_MAX_GAP) {
      out.push({ at: overlays[i].endInTimeline, gap });
    }
  }
  return out;
}

export function preflightProject(project: VideoProject): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const assetById = new Map<string, MediaAsset>(
    project.assets.map((a) => [a.id, a]),
  );

  // ---- base = track de vídeo de menor index com clips ----------------------
  const baseTrack = baseTrackOf(project);
  const baseClips = baseTrack
    ? baseTrack.clips
        .filter((c) => (c.layer ?? 0) === 0 && !c.hidden)
        .sort((a, b) => a.startInTimeline - b.startInTimeline)
    : [];
  const baseEnd = baseClips.reduce((m, c) => Math.max(m, c.endInTimeline), 0);

  // ---- 1. Nada pode alongar a fala -----------------------------------------
  if (baseEnd > 0) {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.hidden) continue;
        if (track.id === baseTrack?.id && (clip.layer ?? 0) === 0) continue;
        if (clip.endInTimeline > baseEnd + 0.05) {
          const asset = assetById.get(clip.assetId);
          issues.push({
            severity: 'erro',
            code: 'alonga-fala',
            message: `"${asset?.name ?? 'clip'}" termina em ${clip.endInTimeline.toFixed(2)}s — DEPOIS do fim da fala (${baseEnd.toFixed(2)}s). Nada pode alongar o vídeo.`,
            at: clip.endInTimeline,
          });
        }
      }
    }
    for (const ct of project.captionTracks) {
      for (const cue of ct.cues) {
        if (cue.endTime > baseEnd + 0.05) {
          issues.push({
            severity: 'aviso',
            code: 'legenda-apos-fala',
            message: `Legenda "${cue.text.slice(0, 24)}…" termina depois do fim da fala (${baseEnd.toFixed(2)}s).`,
            at: cue.endTime,
          });
        }
      }
    }
  }

  // ---- 2. Flash de base <0,5s entre overlays vizinhos ----------------------
  for (const flash of detectFlashes(project)) {
    issues.push({
      severity: 'aviso',
      code: 'flash-de-base',
      message: `Buraco de ${flash.gap.toFixed(2)}s entre overlays em ${flash.at.toFixed(2)}s — a base pisca. Feche o buraco ou espace de vez.`,
      at: flash.at,
    });
  }

  const overlays = overlayClips(project);

  // ---- 3. Overlay opaco tela cheia >3s --------------------------------------
  for (const clip of overlays) {
    const dur = clip.endInTimeline - clip.startInTimeline;
    const vazado = clip.chromaKey?.enabled === true;
    const telaCheia =
      (clip.fit === 'cover' || clip.transform.scale >= 1) &&
      clip.transform.opacity >= 0.99;
    const asset = assetById.get(clip.assetId);
    if (!vazado && telaCheia && dur > 3.05 && asset?.type !== 'audio') {
      issues.push({
        severity: 'aviso',
        code: 'overlay-longo',
        message: `"${asset?.name ?? 'overlay'}" cobre a tela por ${dur.toFixed(1)}s (regra: ≤3s — a voz não fica coberta).`,
        at: clip.startInTimeline,
      });
    }
  }

  // ---- 4. Legenda estourando a largura --------------------------------------
  const stageW = project.resolution.width;
  const stageH = project.resolution.height;
  for (const ct of project.captionTracks) {
    if (!ct.visible) continue;
    for (const cue of ct.cues) {
      const st = cue.style;
      const fontPx = (st.fontSize / 1080) * stageH;
      const maxW = ((st.maxWidthPct ?? 88) / 100) * stageW;
      const longest = Math.max(
        ...cue.text.split('\n').map((l) => l.length),
        0,
      );
      const estWidth = longest * fontPx * CHAR_WIDTH_RATIO;
      if (estWidth > maxW * 1.35) {
        issues.push({
          severity: 'aviso',
          code: 'legenda-larga',
          message: `Legenda "${cue.text.slice(0, 28)}…" deve quebrar em várias linhas (estimados ${Math.round(estWidth)}px numa caixa de ${Math.round(maxW)}px). Use o preset Gabinete ≤5.`,
          at: cue.startTime,
        });
      }
    }
  }

  // ---- 5. Legendas colidindo (recurso 12) -----------------------------------
  // Regra dura: duas legendas NUNCA dividem o mesmo milissegundo — precisa de
  // 30 ms de folga entre uma e outra. O botão "Colisões" na gaveta de legendas
  // resolve sozinho (encurta a anterior, empurra a seguinte).
  for (const ct of project.captionTracks) {
    const sorted = [...ct.cues].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const folga = sorted[i + 1].startTime - sorted[i].endTime;
      if (folga >= CUE_GAP_MIN - 1e-6) continue;
      const encostadas = folga >= 0;
      issues.push({
        severity: 'aviso',
        code: 'legendas-sobrepostas',
        message: encostadas
          ? `Legendas encostadas em ${sorted[i + 1].startTime.toFixed(2)}s (${Math.round(folga * 1000)} ms de folga, mínimo 30 ms). Use "Colisões" na gaveta de legendas.`
          : `Duas legendas ao mesmo tempo em ${sorted[i + 1].startTime.toFixed(2)}s ("${sorted[i].text.slice(0, 18)}…" e "${sorted[i + 1].text.slice(0, 18)}…"). Use "Colisões" na gaveta de legendas.`,
        at: sorted[i + 1].startTime,
      });
    }
  }

  // ---- 6. Mídia importada e não usada ---------------------------------------
  const usados = new Set<string>();
  for (const t of project.tracks) {
    for (const c of t.clips) usados.add(c.assetId);
  }
  for (const asset of project.assets) {
    if (!usados.has(asset.id)) {
      issues.push({
        severity: 'aviso',
        code: 'midia-sem-uso',
        message: `"${asset.name}" foi importada mas não está em nenhum clip.`,
      });
    }
  }

  // ---- 7. Assets subindo / com erro -----------------------------------------
  for (const asset of project.assets) {
    if (!usados.has(asset.id)) continue;
    if (asset.status === 'uploading') {
      issues.push({
        severity: 'erro',
        code: 'midia-subindo',
        message: `"${asset.name}" ainda está subindo — o export server-side vai pular esse clip.`,
      });
    } else if (asset.status === 'error') {
      issues.push({
        severity: 'erro',
        code: 'midia-com-erro',
        message: `"${asset.name}" falhou no upload — reimporte antes de exportar.`,
      });
    }
  }

  // Erros primeiro, depois avisos; dentro do grupo, por instante.
  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'erro' ? -1 : 1;
    return (a.at ?? 0) - (b.at ?? 0);
  });
}
