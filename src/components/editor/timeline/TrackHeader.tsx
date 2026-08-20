'use client';

/**
 * Header (lateral esquerda) de uma track na timeline.
 *
 * Mostra:
 * - Nome da track (V1, V2, A1, …) — clicar seleciona.
 * - Botões: visível, mute, lock.
 *
 * O componente **não** controla largura; o pai (`TimelineTrack`) escolhe.
 */

import { useRef } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { Track } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { trackLayerCount } from '@/lib/editor/preview-utils';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import { useToast } from '@/hooks/use-toast';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

interface TrackHeaderProps {
  track: Track;
  selected: boolean;
}

/** Seleciona a cor lateral da track conforme tipo + index. */
function trackAccent(track: Track): string {
  if (track.type === 'video') {
    if (track.index === 0) return 'var(--editor-track-v1)';
    if (track.index === 1) return 'var(--editor-track-v2)';
    return 'var(--editor-track-v3)';
  }
  if (track.index === 0) return 'var(--editor-track-a1)';
  if (track.index === 1) return 'var(--editor-track-a2)';
  return 'var(--editor-track-a3)';
}

export function TrackHeader({ track, selected }: TrackHeaderProps) {
  const selectTrack = useEditorStore((s) => s.selectTrack);
  const toggleMute = useEditorStore((s) => s.toggleTrackMute);
  const setLocked = useEditorStore((s) => s.setTrackLocked);
  const setVisible = useEditorStore((s) => s.setTrackVisible);
  const addSubtrack = useEditorStore((s) => s.addSubtrack);
  const setTrackAudioOptions = useEditorStore((s) => s.setTrackAudioOptions);
  const removeSubtrack = useEditorStore((s) => s.removeSubtrack);
  const addClipFromAsset = useEditorStore((s) => s.addClipFromAsset);
  const ingest = useIngestFiles();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Camadas (subtracks) só existem em tracks de vídeo.
  const layerCount = trackLayerCount(track);
  const isVideo = track.type === 'video';

  /** Insere arquivos do SO nesta track, no playhead atual. */
  const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    e.target.value = ''; // permite repicar o mesmo arquivo
    if (!files || files.length === 0) return;
    const playhead = useEditorStore.getState().ui.playhead;
    for (const file of Array.from(files)) {
      const kind = mediaTypeOf(file);
      const ok =
        track.type === 'audio'
          ? kind === 'audio'
          : kind === 'video' || kind === 'image';
      if (!ok) {
        toast({
          title: 'Tipo incompatível com a track',
          description:
            track.type === 'audio'
              ? `"${file.name}" não é áudio.`
              : `"${file.name}" não é vídeo/imagem.`,
          variant: 'destructive',
        });
        continue;
      }
      const [asset] = await ingest([file]);
      if (asset) addClipFromAsset(asset.id, track.id, playhead);
    }
  };

  return (
    <div
      onClick={() => selectTrack(track.id)}
      className={cn(
        'flex h-full w-24 shrink-0 cursor-pointer items-center gap-1 px-2',
        'border-b border-border',
        selected
          ? 'bg-muted'
          : 'bg-card hover:bg-muted',
      )}
      style={{ height: track.height }}
    >
      {/* Faixa colorida */}
      <div
        className="h-6 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: trackAccent(track) }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[11px] font-medium text-foreground">
          {track.name}
        </span>
        {/* Controle de TRILHA (volume % / nivelar / fades) — só áudio. */}
        {!isVideo && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                title="Trilha: volume %, nivelar dinâmica, fades automáticos e voz na frente (EQ + duck)"
                className={cn(
                  'w-fit rounded-[var(--editor-radius-sm)] px-0.5 text-left text-[9px] tabular-nums',
                  (track.gainPct ?? 100) !== 100 ||
                    track.audioLeveling ||
                    track.autoFade
                    ? 'text-[var(--editor-accent-strong,theme(colors.violet.400))]'
                    : 'text-muted-foreground',
                  'hover:bg-border hover:text-foreground',
                )}
              >
                {Math.round(track.gainPct ?? 100)}%
                {track.audioLeveling ? ' · niv' : ''}
                {track.autoFade ? ' · fade' : ''}
                {track.voiceEq ? ' · eq' : ''}
                {track.voiceDuck ? ' · duck' : ''}
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-64 p-3"
              align="start"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="mb-2 text-xs font-semibold">Trilha — {track.name}</p>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      Volume da track
                    </span>
                    <span className="text-[10px] tabular-nums">
                      {Math.round(track.gainPct ?? 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[track.gainPct ?? 100]}
                    min={0}
                    max={200}
                    step={1}
                    onValueChange={([v]) =>
                      setTrackAudioOptions(track.id, { gainPct: v ?? 100 })
                    }
                  />
                  <div className="flex gap-1">
                    {[14, 16, 18, 100].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          setTrackAudioOptions(track.id, { gainPct: v })
                        }
                        className={cn(
                          'rounded border border-border px-1.5 py-0.5 text-[10px] tabular-nums hover:bg-muted',
                          Math.round(track.gainPct ?? 100) === v &&
                            'bg-[var(--editor-accent)] text-white',
                        )}
                        title={
                          v === 100
                            ? 'Neutro'
                            : 'Padrão de trilha do gabinete (14–18%)'
                        }
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between gap-2 text-[11px]">
                  <span>
                    Nivelar dinâmica{' '}
                    <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                      export
                    </span>
                  </span>
                  <Switch
                    checked={track.audioLeveling ?? false}
                    onCheckedChange={(v) =>
                      setTrackAudioOptions(track.id, { audioLeveling: v })
                    }
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-[11px]">
                  <span>
                    Fades automáticos (1,2s / 2,5s){' '}
                    <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                      export
                    </span>
                  </span>
                  <Switch
                    checked={track.autoFade ?? false}
                    onCheckedChange={(v) =>
                      setTrackAudioOptions(track.id, { autoFade: v })
                    }
                  />
                </label>

                <div className="space-y-2 rounded-[var(--editor-radius-sm)] border border-border p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Voz na frente
                  </p>

                  <label
                    className="flex items-center justify-between gap-2 text-[11px]"
                    title="Corta o grave (abaixo de 130 Hz) e abaixa 3,5 dB em 2,8 kHz na música: a fala fica inteligível sem precisar baixar a trilha."
                  >
                    <span>
                      Abrir espaço pra voz (EQ){' '}
                      <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                        export
                      </span>
                    </span>
                    <Switch
                      checked={track.voiceEq ?? false}
                      onCheckedChange={(v) =>
                        setTrackAudioOptions(track.id, { voiceEq: v })
                      }
                    />
                  </label>

                  <label
                    className="flex items-center justify-between gap-2 text-[11px]"
                    title="A música abaixa sozinha enquanto ele fala e volta ~0,4 s depois da última palavra (duck por sidechain, com a voz da faixa base como gatilho)."
                  >
                    <span>
                      Abaixar quando ele fala (duck){' '}
                      <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                        export
                      </span>
                    </span>
                    <Switch
                      checked={track.voiceDuck ?? false}
                      onCheckedChange={(v) =>
                        setTrackAudioOptions(track.id, { voiceDuck: v })
                      }
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() =>
                      setTrackAudioOptions(track.id, {
                        gainPct: 16,
                        audioLeveling: true,
                        autoFade: true,
                        voiceEq: true,
                        voiceDuck: true,
                      })
                    }
                    className="w-full rounded border border-border px-1.5 py-1 text-[10px] hover:bg-muted"
                    title="Aplica o preset da produção real: 16%, nivelada, fades, EQ e duck."
                  >
                    Preset trilha do gabinete
                  </button>
                </div>

                <p className="text-[10px] leading-snug text-muted-foreground">
                  A voz nunca abaixa: o export mixa sem atenuar (normalize=0)
                  e um limiter segura só os picos.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        )}
        {/* Controle de CAMADAS (subtracks) — só vídeo. */}
        {isVideo && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                addSubtrack(track.id);
              }}
              title="Adicionar camada (subtrack) por cima"
              disabled={track.locked}
              className={cn(
                'flex h-3.5 w-3.5 items-center justify-center rounded-[var(--editor-radius-sm)]',
                'text-muted-foreground hover:bg-border hover:text-foreground',
                'disabled:opacity-40',
              )}
            >
              <EditorIcons.Plus className="h-2.5 w-2.5" />
            </button>
            <span
              className="text-[9px] tabular-nums text-muted-foreground"
              title={`${layerCount} camada(s)`}
            >
              {layerCount > 1 ? `${layerCount} camadas` : '1 camada'}
            </span>
            {layerCount > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Remove a camada do TOPO (índice maior).
                  removeSubtrack(track.id, layerCount - 1);
                }}
                title="Remover a camada de cima (e seus clips)"
                disabled={track.locked}
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-[var(--editor-radius-sm)]',
                  'text-muted-foreground hover:bg-border hover:text-foreground',
                  'disabled:opacity-40',
                )}
              >
                <EditorIcons.Minus className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Grade 2x2: 4 botões de 20px estouravam os 96px do header e
          cobriam os controles da coluna do nome (camadas / trilha %). */}
      <div className="grid shrink-0 grid-cols-2 gap-0.5">
        {/* Adicionar mídia direto nesta track (atalho de inclusão). */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={track.type === 'audio' ? 'audio/*' : 'video/*,image/*'}
          onChange={handlePickFiles}
        />
        <IconBtn
          active
          onClick={(e) => {
            e.stopPropagation();
            if (track.locked) return;
            fileInputRef.current?.click();
          }}
          title={
            track.locked
              ? 'Track travada'
              : track.type === 'audio'
                ? 'Adicionar áudio nesta track'
                : 'Adicionar mídia nesta track'
          }
        >
          <EditorIcons.Plus
            className={cn('h-3 w-3', track.locked && 'opacity-40')}
          />
        </IconBtn>

        <IconBtn
          active={track.visible}
          onClick={(e) => {
            e.stopPropagation();
            setVisible(track.id, !track.visible);
          }}
          title={track.visible ? 'Ocultar' : 'Mostrar'}
        >
          {track.visible ? (
            <EditorIcons.Eye className="h-3 w-3" />
          ) : (
            <EditorIcons.EyeOff className="h-3 w-3" />
          )}
        </IconBtn>

        <IconBtn
          active={!track.muted}
          onClick={(e) => {
            e.stopPropagation();
            toggleMute(track.id);
          }}
          title={track.muted ? 'Desmutar' : 'Mutar'}
        >
          {track.muted ? (
            <EditorIcons.VolumeOff className="h-3 w-3" />
          ) : (
            <EditorIcons.VolumeOn className="h-3 w-3" />
          )}
        </IconBtn>

        <IconBtn
          active={!track.locked}
          onClick={(e) => {
            e.stopPropagation();
            setLocked(track.id, !track.locked);
          }}
          title={track.locked ? 'Destravar' : 'Travar'}
        >
          {track.locked ? (
            <EditorIcons.Lock className="h-3 w-3" />
          ) : (
            <EditorIcons.Unlock className="h-3 w-3" />
          )}
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-[var(--editor-radius-sm)]',
        'transition-colors duration-fast ease-editor',
        active
          ? 'text-foreground hover:bg-border'
          : 'text-muted-foreground hover:bg-border',
      )}
    >
      {children}
    </button>
  );
}
