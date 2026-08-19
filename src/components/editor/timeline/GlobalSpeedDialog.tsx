'use client';

/**
 * Diálogo "Velocidade da fala" (recurso 4 do fluxo do gabinete).
 *
 * Aplica um fator de velocidade GLOBAL ao projeto com remap automático da
 * timeline inteira (mesmo algoritmo do `_prep_xfade.py` da produção real):
 * a base acelera (playbackRate), imagens/legendas comprimem junto, memes e
 * sons só deslocam o início (duração natural), a trilha comprime, e a
 * vinheta de encerramento NUNCA acelera.
 *
 * É uma TRANSFORMAÇÃO (não um estado vivo): aplicar 1,14x duas vezes = 1,30x.
 * Ctrl+Z desfaz a aplicação inteira em um passo.
 */

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const PRESETS = [1.1, 1.14, 1.2, 1.25];

interface GlobalSpeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalSpeedDialog({ open, onOpenChange }: GlobalSpeedDialogProps) {
  const { toast } = useToast();
  const speechRate = useEditorStore((s) => s.project?.speechRate ?? 1);
  const duration = useEditorStore((s) => s.project?.duration ?? 0);
  const applyGlobalSpeed = useEditorStore((s) => s.applyGlobalSpeed);

  const [factor, setFactor] = React.useState('1.14');

  const parsed = Number(factor.replace(',', '.'));
  const valido = Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2 && Math.abs(parsed - 1) > 1e-6;
  const novaDuracao = valido && duration > 0 ? duration / parsed : null;

  const handleApply = () => {
    if (!valido) return;
    const ok = applyGlobalSpeed(parsed);
    if (ok) {
      toast({
        title: `Velocidade ${parsed.toFixed(2).replace('.', ',')}x aplicada`,
        description:
          'Timeline inteira remapeada — base acelerada, legendas e imagens comprimidas, memes/sons deslocados. Ctrl+Z desfaz.',
      });
      onOpenChange(false);
    } else {
      toast({
        title: 'Não deu para aplicar',
        description: 'O projeto precisa de uma track de vídeo com clips.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Velocidade da fala (projeto)</DialogTitle>
          <DialogDescription className="text-xs">
            Acelera a base e remapeia a timeline inteira: legendas e imagens
            acompanham a fala; memes e sons mantêm a duração natural; a
            vinheta nunca acelera.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {speechRate !== 1 && (
            <p className="rounded bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
              Fator já aplicado neste projeto:{' '}
              <strong>{speechRate.toFixed(2).replace('.', ',')}x</strong>{' '}
              (aplicar de novo acumula).
            </p>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="gs-factor" className="text-xs">
                Fator (0,5 – 2,0)
              </Label>
              <Input
                id="gs-factor"
                value={factor}
                onChange={(e) => setFactor(e.target.value)}
                className="h-8 text-sm tabular-nums"
                inputMode="decimal"
              />
            </div>
            <div className="flex gap-1 pb-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFactor(String(p))}
                  className={cn(
                    'rounded border border-border px-1.5 py-1 text-[11px] tabular-nums',
                    'hover:bg-muted',
                    Number(factor.replace(',', '.')) === p &&
                      'bg-[var(--editor-accent)] text-white',
                  )}
                >
                  {String(p).replace('.', ',')}x
                </button>
              ))}
            </div>
          </div>

          {novaDuracao !== null && (
            <p className="text-[11px] text-muted-foreground">
              Duração: {duration.toFixed(1).replace('.', ',')}s →{' '}
              <strong>{novaDuracao.toFixed(1).replace('.', ',')}s</strong>
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={handleApply} disabled={!valido}>
              Aplicar e remapear
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
