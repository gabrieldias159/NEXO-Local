'use client';

/**
 * Controles de transporte do preview (play/pause/seek/loop).
 *
 * Lê estado de playback do store (`ui.isPlaying`, `ui.playhead`,
 * `project.duration`) e dispara `play()`/`pause()`/`setPlayhead()`.
 *
 * Versão atual (refactor) faz o "transport" controlar apenas o estado
 * lógico do store. A sincronização com o `<video>` real virá na fase de
 * playback.
 */

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useEditorStore } from '@/lib/editor/store';
import { useAudioMixer } from '@/lib/editor/playback';
import { useFirestore, useMemoFirebase, useDoc } from '@/firebase';
import { doc } from 'firebase/firestore';
import { EditorIcons } from '../shared/EditorIcons';
import { cn, formatTimecode } from '@/lib/utils';
import type { AppearanceConfig } from '@/lib/types';

// (formatTime removida — usa formatTimecode do utils, com frames.)

interface PreviewControlsProps {
  className?: string;
}

export function PreviewControls({ className }: PreviewControlsProps) {
  const isPlaying = useEditorStore((s) => s.ui.isPlaying);
  const playhead = useEditorStore((s) => s.ui.playhead);
  const isLooping = useEditorStore((s) => s.ui.isLooping);
  const duration = useEditorStore((s) => s.project?.duration ?? 0);
  const frameRate = useEditorStore((s) => s.project?.frameRate ?? 30);

  const stageBackground = useEditorStore(
    (s) => s.project?.stageBackground ?? '#000000',
  );
  const setStageBackground = useEditorStore((s) => s.setStageBackground);

  const overlays = useEditorStore((s) => s.project?.overlays);
  const setOverlays = useEditorStore((s) => s.setOverlays);

  const firestore = useFirestore();
  const configRef = useMemoFirebase(
    () => (firestore ? doc(firestore, 'configs', 'main') : null),
    [firestore],
  );
  const { data: configData } = useDoc<AppearanceConfig>(configRef);
  const hasLogo = !!configData?.videoLogoUrl;
  const hasFooter = !!configData?.videoFooterUrl;
  const hasEnding = !!configData?.videoEncerramentoUrl;

  const togglePlay = useEditorStore((s) => s.togglePlay);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setLoopRange = useEditorStore((s) => s.setLoopRange);

  // Web Audio API exige um gesto do usuário antes de tocar — garantimos que
  // o contexto saia de `suspended` ao primeiro click no Play.
  const { ensureContextResumed } = useAudioMixer();

  const handleTogglePlay = async () => {
    try {
      await ensureContextResumed();
    } catch {
      // Se o mixer ainda não estiver pronto (engine não montada), seguimos
      // com o toggle — o store-only não depende do áudio.
    }
    togglePlay();
  };

  const safeDuration = Math.max(duration, 0.01);

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2',
        'border-t border-border bg-background',
        className,
      )}
    >
      {/* Skip back */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setPlayhead(0)}
        title="Início"
      >
        <EditorIcons.SkipBack className="h-4 w-4" />
      </Button>

      {/* Play / Pause */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleTogglePlay}
        title={isPlaying ? 'Pausar (Space)' : 'Reproduzir (Space)'}
      >
        {isPlaying ? (
          <EditorIcons.Pause className="h-4 w-4" />
        ) : (
          <EditorIcons.Play className="h-4 w-4" />
        )}
      </Button>

      {/* Skip forward → fim */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setPlayhead(duration)}
        title="Fim"
      >
        <EditorIcons.SkipForward className="h-4 w-4" />
      </Button>

      {/* Frame anterior / próximo */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setPlayhead(Math.max(0, playhead - 1 / frameRate))}
        title="Frame anterior (←)"
      >
        <EditorIcons.ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setPlayhead(Math.min(duration, playhead + 1 / frameRate))}
        title="Próximo frame (→)"
      >
        <EditorIcons.ChevronRight className="h-4 w-4" />
      </Button>

      {/* Loop toggle */}
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8', isLooping && 'text-[var(--editor-accent)]')}
        onClick={() => {
          if (isLooping) {
            setLoopRange(null);
          } else {
            setLoopRange({ start: 0, end: duration });
          }
        }}
        title={isLooping ? 'Desativar loop' : 'Ativar loop'}
      >
        <EditorIcons.Loop className="h-4 w-4" />
      </Button>

      {/* Seek bar */}
      <div className="flex flex-1 items-center gap-2">
        <Slider
          value={[Math.min(playhead, safeDuration)]}
          min={0}
          max={safeDuration}
          step={0.01}
          onValueChange={([v]) => setPlayhead(v ?? 0)}
          className="flex-1"
        />
      </div>

      {/* Timecode esperto — só mostra as unidades necessárias + frames */}
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatTimecode(playhead, frameRate)} / {formatTimecode(duration, frameRate)}
      </span>

      {/* Sobreposições */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              (overlays?.logo || overlays?.footer || overlays?.ending) &&
                'text-[var(--editor-accent)]',
            )}
            title="Sobreposições"
          >
            <EditorIcons.Layers className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="end">
          <p className="mb-3 text-xs font-semibold">Sobreposições</p>
          <div className="space-y-3">
            <OverlayRow
              id="ov-logo"
              label="Logo"
              description="Canto superior direito"
              checked={overlays?.logo ?? false}
              disabled={!hasLogo}
              onCheckedChange={(v) => setOverlays({ logo: v })}
            />
            <OverlayRow
              id="ov-footer"
              label="Rodapé"
              description="Parte inferior"
              checked={overlays?.footer ?? false}
              disabled={!hasFooter}
              onCheckedChange={(v) => setOverlays({ footer: v })}
            />
            <OverlayRow
              id="ov-ending"
              label="Vinheta Final"
              description="Camada bloqueada ao final"
              checked={overlays?.ending ?? false}
              disabled={!hasEnding}
              onCheckedChange={(v) => setOverlays({ ending: v })}
            />
          </div>
          {(!hasLogo || !hasFooter || !hasEnding) && (
            <p className="mt-3 text-[10px] text-muted-foreground">
              Assets não configurados são desabilitados. Configure em Aparência.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {/* Fundo do palco */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Cor do fundo do palco"
          >
            <EditorIcons.Palette className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3" align="end">
          <p className="mb-2 text-xs font-medium">Fundo do palco</p>
          <div className="mb-2 grid grid-cols-6 gap-1.5">
            {[
              '#000000',
              '#ffffff',
              '#1a1a1a',
              '#0f172a',
              '#1f2937',
              '#dc2626',
              '#16a34a',
              '#2563eb',
              '#7c3aed',
              '#ea580c',
              '#0891b2',
              '#facc15',
            ].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setStageBackground(c)}
                title={c}
                className={cn(
                  'h-6 w-6 rounded border transition-transform hover:scale-110',
                  stageBackground === c
                    ? 'ring-2 ring-primary ring-offset-1'
                    : 'border-border',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={stageBackground}
              onChange={(e) => setStageBackground(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border p-0.5"
            />
            <span className="font-mono text-xs">{stageBackground}</span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function OverlayRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', disabled && 'opacity-40')}>
      <Label htmlFor={id} className="flex flex-col gap-0.5 cursor-pointer">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[10px] text-muted-foreground">{description}</span>
      </Label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="shrink-0"
      />
    </div>
  );
}
