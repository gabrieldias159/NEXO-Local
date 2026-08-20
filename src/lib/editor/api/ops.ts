/**
 * Motor de OPERAÇÕES da API de automação do Estúdio de Vídeo.
 *
 * Funções puras sobre o objeto do projeto (mesmo shape de `VideoProject`, na
 * forma "plana" em que ele vive no Firestore). Cada operação valida o que
 * precisa e devolve o projeto alterado — quem persiste é a rota.
 *
 * Por que operações em LOTE em vez de um endpoint por ação: quem consome isto é
 * um agente. Uma lista declarativa aplicada de uma vez é mais fácil de
 * escrever, roda num ciclo só (lê → aplica tudo → grava) e evita o vaivém de N
 * chamadas com estados intermediários inconsistentes.
 *
 * Os defaults (transform, filters, audio) espelham `src/lib/editor/store.ts`.
 * Se lá mudar, aqui muda junto — um clip criado por aqui tem de ser
 * indistinguível de um criado pela interface.
 */

// ── Defaults (espelham o store) ─────────────────────────────────────────────

export const TRANSFORM_PADRAO = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
  anchorX: 0.5, anchorY: 0.5, flipH: false, flipV: false,
};
export const FILTROS_PADRAO = {
  brightness: 1, contrast: 1, saturation: 1, blur: 0, hue: 0, grayscale: 0,
};
export const LEGENDA_ESTILO_PADRAO = {
  fontFamily: 'Inter',
  fontSize: 36,
  fontWeight: 600,
  color: '#FFFFFF',
  backgroundColor: '#000000B3',
  align: 'center',
  position: 'bottom',
  paddingX: 12,
  paddingY: 4,
  borderRadius: 4,
};

export const AUDIO_PADRAO = {
  volume: 1, muted: false, fadeInDuration: 0, fadeOutDuration: 0, pan: 0,
};

export const RESOLUCOES: Record<string, { width: number; height: number; label: string }> = {
  '1080p': { width: 1920, height: 1080, label: '1920x1080' },
  '720p': { width: 1280, height: 720, label: '1280x720' },
  vertical: { width: 720, height: 1280, label: 'Vertical 9:16' },
  'vertical-1080': { width: 1080, height: 1920, label: 'Vertical 9:16 · 1080p' },
  quadrado: { width: 1080, height: 1080, label: 'Quadrado 1:1' },
  '4:5': { width: 1080, height: 1350, label: 'Retrato 4:5' },
};

// ── Tipos ───────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Projeto = Record<string, any>;

export interface Operacao {
  op: string;
  [k: string]: unknown;
}

export interface ResultadoOp {
  op: string;
  ok: boolean;
  /** id criado/afetado — o agente usa para encadear a próxima operação. */
  id?: string;
  detalhe?: string;
}

// ── Utilidades ──────────────────────────────────────────────────────────────

export function gerarId(prefixo: string): string {
  return `${prefixo}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function erro(msg: string): never {
  throw new Error(msg);
}

function acharTrack(p: Projeto, trackId: string) {
  const t = (p.tracks ?? []).find((x: any) => x.id === trackId);
  if (!t) erro(`track '${trackId}' nao existe`);
  return t;
}

function acharClip(p: Projeto, clipId: string): { track: any; clip: any } {
  for (const t of p.tracks ?? []) {
    const c = (t.clips ?? []).find((x: any) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return erro(`clip '${clipId}' nao existe`);
}

/** Duração do projeto = maior `endInTimeline` entre todos os clips. */
export function recalcularDuracao(p: Projeto): number {
  let max = 0;
  for (const t of p.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (typeof c.endInTimeline === 'number' && c.endInTimeline > max) max = c.endInTimeline;
    }
  }
  p.duration = Number(max.toFixed(3));
  return p.duration;
}

// ── Fábrica de projeto ──────────────────────────────────────────────────────

export function novoProjeto(input: {
  name: string;
  ownerUid: string;
  resolucao?: string;
  frameRate?: 24 | 30 | 60;
  stageMode?: 'single' | 'split-vertical';
}): Projeto {
  const preset = RESOLUCOES[input.resolucao ?? 'vertical'];
  if (!preset) {
    erro(`resolucao '${input.resolucao}' desconhecida. Use: ${Object.keys(RESOLUCOES).join(', ')}`);
  }
  const agora = new Date();
  return {
    id: gerarId('proj'),
    name: input.name,
    ownerUid: input.ownerUid,
    createdAt: agora,
    updatedAt: agora,
    resolution: { ...preset },
    frameRate: input.frameRate ?? 30,
    duration: 0,
    stageMode: input.stageMode ?? 'single',
    splitRatio: 0.5,
    assets: [],
    tracks: [],
    captionTracks: [],
    audioMaster: { volume: 1, muted: false },
  };
}

// ── Operações ───────────────────────────────────────────────────────────────

type Manipulador = (p: Projeto, o: Operacao) => ResultadoOp;

const OPS: Record<string, Manipulador> = {
  /** Ajusta metadados do projeto. */
  setProject: (p, o) => {
    const patch = (o.patch ?? {}) as Record<string, unknown>;
    if (patch.resolucao) {
      const r = RESOLUCOES[patch.resolucao as string];
      if (!r) erro(`resolucao '${patch.resolucao}' desconhecida`);
      p.resolution = { ...r };
    }
    for (const k of ['name', 'frameRate', 'stageMode', 'splitRatio', 'stageBackground'] as const) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    if (patch.overlays) p.overlays = { ...(p.overlays ?? {}), ...(patch.overlays as object) };
    if (patch.identity) p.identity = { ...(p.identity ?? {}), ...(patch.identity as object) };
    return { op: 'setProject', ok: true, id: p.id };
  },

  /**
   * Registra uma mídia no acervo do projeto. NÃO faz upload: recebe uma URL já
   * acessível (http/https) ou um path do Storage que já exista.
   */
  addAsset: (p, o) => {
    const url = String(o.url ?? '');
    if (!url) erro('addAsset exige `url`');
    const tipo = String(o.tipo ?? 'video');
    if (!['video', 'image', 'audio'].includes(tipo)) {
      erro(`tipo '${tipo}' invalido (use video, image ou audio)`);
    }
    const asset: Record<string, unknown> = {
      id: gerarId('asset'),
      name: String(o.nome ?? url.split('/').pop() ?? 'midia'),
      type: tipo,
      source: o.storagePath ? 'firebase' : 'local-blob',
      downloadUrl: url,
      size: Number(o.size ?? 0),
      status: 'ready',
      createdAt: new Date(),
    };
    if (o.storagePath) asset.storagePath = String(o.storagePath);
    if (o.duracao !== undefined) asset.duration = Number(o.duracao);
    if (o.width !== undefined) asset.width = Number(o.width);
    if (o.height !== undefined) asset.height = Number(o.height);

    p.assets = [...(p.assets ?? []), asset];
    return { op: 'addAsset', ok: true, id: asset.id as string };
  },

  removeAsset: (p, o) => {
    const id = String(o.assetId ?? '');
    const usado = (p.tracks ?? []).some((t: any) =>
      (t.clips ?? []).some((c: any) => c.assetId === id));
    if (usado) erro(`asset '${id}' esta em uso por um clip; remova o clip antes`);
    p.assets = (p.assets ?? []).filter((a: any) => a.id !== id);
    return { op: 'removeAsset', ok: true, id };
  },

  addTrack: (p, o) => {
    const tipo = String(o.tipo ?? 'video');
    if (!['video', 'audio'].includes(tipo)) erro(`tipo de track '${tipo}' invalido`);
    const track: Record<string, unknown> = {
      id: gerarId('track'),
      type: tipo,
      name: String(o.nome ?? (tipo === 'video' ? 'Video' : 'Audio')),
      index: (p.tracks ?? []).length,
      muted: false,
      locked: false,
      visible: true,
      solo: false,
      height: 64,
      clips: [],
    };
    if (o.stageSlot) track.stageSlot = String(o.stageSlot);
    p.tracks = [...(p.tracks ?? []), track];
    return { op: 'addTrack', ok: true, id: track.id as string };
  },

  /**
   * Ajusta uma track existente. Só o que a interface também ajusta:
   * nome, mute/lock/visível e as opções de TRILHA (volume %, nivelar,
   * fades automáticos, EQ de voz e duck). Campos ausentes ficam como estão.
   */
  updateTrack: (p, o) => {
    const id = String(o.trackId ?? '');
    const track = (p.tracks ?? []).find((t: any) => t.id === id);
    if (!track) erro(`track '${id}' nao existe`);
    const patch = (o.patch ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    if (typeof patch.nome === 'string') track.name = patch.nome;
    if (bool(patch.muted) !== undefined) track.muted = patch.muted;
    if (bool(patch.locked) !== undefined) track.locked = patch.locked;
    if (bool(patch.visible) !== undefined) track.visible = patch.visible;
    if (num(patch.gainPct) !== undefined) {
      track.gainPct = Math.max(0, Math.min(200, patch.gainPct as number));
    }
    if (bool(patch.audioLeveling) !== undefined) {
      track.audioLeveling = patch.audioLeveling;
    }
    if (bool(patch.autoFade) !== undefined) track.autoFade = patch.autoFade;
    if (bool(patch.voiceEq) !== undefined) track.voiceEq = patch.voiceEq;
    if (bool(patch.voiceDuck) !== undefined) track.voiceDuck = patch.voiceDuck;
    return { op: 'updateTrack', ok: true, id };
  },

  removeTrack: (p, o) => {
    const id = String(o.trackId ?? '');
    p.tracks = (p.tracks ?? []).filter((t: any) => t.id !== id);
    (p.tracks ?? []).forEach((t: any, i: number) => {
      t.index = i;
    });
    recalcularDuracao(p);
    return { op: 'removeTrack', ok: true, id };
  },

  /**
   * Põe um trecho da mídia na timeline — é a operação de RECORTE.
   *
   * `inicioNaMidia`/`fimNaMidia` recortam a fonte; `inicioNaTimeline` diz onde
   * o trecho entra. Omitindo `inicioNaTimeline`, o clip é anexado ao fim do que
   * já existe na track (montagem sequencial, o caso comum).
   */
  addClip: (p, o) => {
    const assetId = String(o.assetId ?? '');
    const asset = (p.assets ?? []).find((a: any) => a.id === assetId);
    if (!asset) erro(`asset '${assetId}' nao existe no projeto`);

    const track = acharTrack(p, String(o.trackId ?? ''));
    if (track.type === 'audio' && asset.type === 'image') {
      erro('nao da para por uma imagem numa track de audio');
    }

    const inicioMidia = Number(o.inicioNaMidia ?? 0);
    const fimMidia = Number(o.fimNaMidia ?? asset.duration ?? 5);
    if (!(fimMidia > inicioMidia)) erro('fimNaMidia precisa ser maior que inicioNaMidia');
    const dur = fimMidia - inicioMidia;

    let inicioTl: number;
    if (o.inicioNaTimeline !== undefined) {
      inicioTl = Number(o.inicioNaTimeline);
    } else {
      inicioTl = (track.clips ?? []).reduce(
        (m: number, c: any) => Math.max(m, c.endInTimeline ?? 0), 0);
    }

    const clip: Record<string, unknown> = {
      id: gerarId('clip'),
      assetId,
      trackId: track.id,
      startInTimeline: Number(inicioTl.toFixed(3)),
      endInTimeline: Number((inicioTl + dur).toFixed(3)),
      startInAsset: Number(inicioMidia.toFixed(3)),
      endInAsset: Number(fimMidia.toFixed(3)),
      slot: String(o.slot ?? track.stageSlot ?? 'full'),
      playbackRate: Number(o.velocidade ?? 1),
      transform: { ...TRANSFORM_PADRAO },
      filters: { ...FILTROS_PADRAO },
      audio: { ...AUDIO_PADRAO },
      keyframes: [],
      locked: false,
      hidden: false,
    };
    if (o.layer !== undefined) clip.layer = Number(o.layer);
    if (o.fit) clip.fit = String(o.fit);

    track.clips = [...(track.clips ?? []), clip];
    track.clips.sort((a: any, b: any) => a.startInTimeline - b.startInTimeline);
    recalcularDuracao(p);
    return { op: 'addClip', ok: true, id: clip.id as string };
  },

  /** Edita um clip: tempos, efeitos, transform, áudio, velocidade. */
  updateClip: (p, o) => {
    const { clip } = acharClip(p, String(o.clipId ?? ''));
    const patch = (o.patch ?? {}) as Record<string, any>;

    const mapaTempos: Record<string, string> = {
      inicioNaTimeline: 'startInTimeline',
      fimNaTimeline: 'endInTimeline',
      inicioNaMidia: 'startInAsset',
      fimNaMidia: 'endInAsset',
    };
    for (const [pt, en] of Object.entries(mapaTempos)) {
      if (patch[pt] !== undefined) clip[en] = Number(Number(patch[pt]).toFixed(3));
    }
    if (clip.endInTimeline <= clip.startInTimeline) {
      erro('o clip ficaria com duracao zero ou negativa na timeline');
    }

    if (patch.velocidade !== undefined) clip.playbackRate = Number(patch.velocidade);
    if (patch.slot !== undefined) clip.slot = String(patch.slot);
    if (patch.layer !== undefined) clip.layer = Number(patch.layer);
    if (patch.fit !== undefined) clip.fit = String(patch.fit);
    if (patch.oculto !== undefined) clip.hidden = Boolean(patch.oculto);
    if (patch.travado !== undefined) clip.locked = Boolean(patch.travado);

    // Efeitos: MESCLADOS, não substituídos — o agente manda só o que muda.
    if (patch.transform) clip.transform = { ...clip.transform, ...patch.transform };
    if (patch.filtros) clip.filters = { ...clip.filters, ...patch.filtros };
    if (patch.audio) clip.audio = { ...clip.audio, ...patch.audio };
    if (patch.chromaKey) clip.chromaKey = { ...(clip.chromaKey ?? {}), ...patch.chromaKey };

    recalcularDuracao(p);
    return { op: 'updateClip', ok: true, id: clip.id };
  },

  removeClip: (p, o) => {
    const id = String(o.clipId ?? '');
    const { track } = acharClip(p, id);
    track.clips = track.clips.filter((c: any) => c.id !== id);
    recalcularDuracao(p);
    return { op: 'removeClip', ok: true, id };
  },

  /** Corta um clip em dois no instante dado (tempo da TIMELINE). */
  splitClip: (p, o) => {
    const { track, clip } = acharClip(p, String(o.clipId ?? ''));
    const t = Number(o.emSegundos);
    if (!(t > clip.startInTimeline && t < clip.endInTimeline)) {
      erro(`o corte precisa cair DENTRO do clip (${clip.startInTimeline}s a ${clip.endInTimeline}s)`);
    }
    const proporcao = (t - clip.startInTimeline) / (clip.endInTimeline - clip.startInTimeline);
    const pontoNaMidia = clip.startInAsset + proporcao * (clip.endInAsset - clip.startInAsset);

    const direita = {
      ...structuredClone(clip),
      id: gerarId('clip'),
      startInTimeline: Number(t.toFixed(3)),
      startInAsset: Number(pontoNaMidia.toFixed(3)),
    };
    clip.endInTimeline = Number(t.toFixed(3));
    clip.endInAsset = Number(pontoNaMidia.toFixed(3));

    track.clips.push(direita);
    track.clips.sort((a: any, b: any) => a.startInTimeline - b.startInTimeline);
    recalcularDuracao(p);
    return { op: 'splitClip', ok: true, id: direita.id, detalhe: `cortado em ${t}s` };
  },

  /** Transição de entrada/saída de um clip. */
  setTransition: (p, o) => {
    const { clip } = acharClip(p, String(o.clipId ?? ''));
    const onde = String(o.onde ?? 'in');
    if (!['in', 'out'].includes(onde)) erro('o campo `onde` deve ser in ou out');
    const cfg = { type: String(o.tipo ?? 'fade'), duration: Number(o.duracao ?? 0.5) };
    if (onde === 'in') clip.transitionIn = cfg;
    else clip.transitionOut = cfg;
    return { op: 'setTransition', ok: true, id: clip.id };
  },

  /** Cria/substitui uma faixa de legendas com as falas e seus tempos. */
  setCaptions: (p, o) => {
    const cues = (o.cues ?? []) as Array<{ inicio: number; fim: number; texto: string; slot?: string }>;
    if (!Array.isArray(cues) || cues.length === 0) erro('setCaptions exige `cues` nao vazio');
    const existentes = (p.captionTracks ?? []).filter((t: any) => t.id !== String(o.captionTrackId ?? ''));
    const faixa = {
      id: String(o.captionTrackId ?? gerarId('cap')),
      name: String(o.nome ?? 'Legendas'),
      // `index` e `locked` sao OBRIGATORIOS em CaptionTrack; sem eles o editor
      // quebra ao montar a faixa.
      index: existentes.length,
      locked: false,
      visible: true,
      language: String(o.idioma ?? 'pt-BR'),
      source: 'ai',
      cues: cues.map((c) => ({
        id: gerarId('cue'),
        startTime: Number(c.inicio),
        endTime: Number(c.fim),
        text: String(c.texto),
        // `slot` e `style` tambem sao obrigatorios: o preview le
        // `cue.style.position` direto e estoura em undefined sem eles.
        slot: String(c.slot ?? o.slot ?? 'full'),
        style: { ...LEGENDA_ESTILO_PADRAO, ...((o.estilo ?? {}) as object) },
      })),
    };
    p.captionTracks = [...existentes, faixa];
    return { op: 'setCaptions', ok: true, id: faixa.id, detalhe: `${cues.length} falas` };
  },
};

/** Nomes de operação aceitos — a rota usa para responder erro útil. */
export const OPS_DISPONIVEIS = Object.keys(OPS);

/**
 * Aplica a lista de operações EM ORDEM sobre o projeto.
 *
 * Tudo ou nada: qualquer operação que falhe aborta o lote e a exceção sobe, de
 * modo que a rota não persista um projeto meio-editado.
 */
export function aplicarOperacoes(p: Projeto, ops: Operacao[]): ResultadoOp[] {
  const saida: ResultadoOp[] = [];
  ops.forEach((o, i) => {
    const fn = OPS[o.op];
    if (!fn) {
      erro(`operacao '${o.op}' (indice ${i}) nao existe. Disponiveis: ${OPS_DISPONIVEIS.join(', ')}`);
    }
    try {
      saida.push(fn(p, o));
    } catch (e) {
      erro(`operacao '${o.op}' (indice ${i}) falhou: ${(e as Error).message}`);
    }
  });
  p.updatedAt = new Date();
  return saida;
}
