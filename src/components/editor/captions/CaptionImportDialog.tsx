'use client';

/**
 * Dialog para importar arquivos `.srt` / `.vtt`.
 *
 * Fluxo:
 * 1. Usuário arrasta o arquivo no drop-zone ou clica em "Selecionar arquivo".
 * 2. Lemos o arquivo, parseamos com `parseSubtitleFile`.
 * 3. Mostramos preview das primeiras 5 cues + contagem total.
 * 4. Usuário escolhe **substituir** (track inteira é trocada) ou **anexar**
 *    (cues somam-se ao final).
 * 5. Click em "Importar" dispara `onConfirm({ cues, mode })`.
 *
 * Em caso de parse vazio: mostra aviso e desabilita "Importar".
 */

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  parseSubtitleFile,
  type ParsedCue,
} from '@/lib/editor/captions/parser';
import { formatTimecode } from '@/lib/editor/captions/utils';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { EditorIcons } from '../shared/EditorIcons';

export type ImportMode = 'replace' | 'append';

export interface CaptionImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tem track existente? Se não, "replace"/"append" não fazem diferença. */
  hasExistingCues: boolean;
  onConfirm: (cues: ParsedCue[], mode: ImportMode, filename: string) => void;
}

export function CaptionImportDialog({
  open,
  onOpenChange,
  hasExistingCues,
  onConfirm,
}: CaptionImportDialogProps) {
  const [file, setFile] = React.useState<File | null>(null);
  const [cues, setCues] = React.useState<ParsedCue[] | null>(null);
  const [mode, setMode] = React.useState<ImportMode>('append');
  const [parsing, setParsing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Reset quando o dialog fechar.
  React.useEffect(() => {
    if (!open) {
      setFile(null);
      setCues(null);
      setError(null);
      setParsing(false);
    }
  }, [open]);

  const handleFile = React.useCallback(
    async (f: File) => {
      setFile(f);
      setError(null);
      setParsing(true);
      try {
        const parsed = await parseSubtitleFile(f);
        setCues(parsed);
        if (parsed.length === 0) {
          setError(
            'Não foi possível extrair legendas. O arquivo pode estar mal formatado.',
          );
        }
      } catch (err) {
        console.error('[CaptionImportDialog] erro:', err);
        setError('Erro ao ler o arquivo.');
        setCues([]);
      } finally {
        setParsing(false);
      }
    },
    [],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (
      !/\.(srt|vtt)$/i.test(f.name) &&
      !['text/plain', 'text/vtt', 'application/x-subrip'].includes(f.type)
    ) {
      toast({
        title: 'Formato não suportado',
        description: 'Aceitamos apenas `.srt` ou `.vtt`.',
        variant: 'destructive',
      });
      return;
    }
    handleFile(f);
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const handleConfirm = () => {
    if (!file || !cues || cues.length === 0) return;
    onConfirm(cues, mode, file.name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar legendas</DialogTitle>
          <DialogDescription>
            Aceitamos arquivos <code>.srt</code> e <code>.vtt</code>. Sem IA —
            apenas parse local do arquivo.
          </DialogDescription>
        </DialogHeader>

        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--editor-radius-md)] border-2 border-dashed p-6 text-center transition-colors',
            file
              ? 'border-[var(--editor-accent-strong)] bg-card'
              : 'border-border hover:border-muted-foreground',
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".srt,.vtt,text/plain"
            className="hidden"
            onChange={onFilePick}
          />
          <EditorIcons.Upload className="h-6 w-6 text-muted-foreground" />
          {file ? (
            <div>
              <p className="text-sm font-medium text-foreground">
                {file.name}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Arraste um arquivo ou clique para selecionar
              </p>
              <p className="text-[10px] text-muted-foreground">
                .srt · .vtt
              </p>
            </>
          )}
        </div>

        {/* Status / preview */}
        {parsing && (
          <p className="text-xs text-muted-foreground">
            Lendo arquivo…
          </p>
        )}

        {error && (
          <p className="text-xs text-[var(--editor-danger)]">{error}</p>
        )}

        {cues && cues.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">
                {cues.length}
              </strong>{' '}
              cue(s) detectada(s). Preview das primeiras 5:
            </p>
            <div className="max-h-[160px] overflow-y-auto rounded-[var(--editor-radius-sm)] border border-border bg-background p-2">
              {cues.slice(0, 5).map((c, i) => (
                <div
                  key={i}
                  className="flex gap-2 border-b border-border py-1 last:border-0"
                >
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {formatTimecode(c.startTime)}
                  </span>
                  <span className="flex-1 text-[11px] text-foreground">
                    {c.text.split('\n').join(' / ')}
                  </span>
                </div>
              ))}
              {cues.length > 5 && (
                <p className="pt-1 text-[10px] italic text-muted-foreground">
                  …e mais {cues.length - 5}.
                </p>
              )}
            </div>

            {hasExistingCues && (
              <div className="rounded-[var(--editor-radius-sm)] border border-border p-2">
                <Label className="text-xs font-medium text-foreground">
                  Como mesclar?
                </Label>
                <RadioGroup
                  value={mode}
                  onValueChange={(v) => setMode(v as ImportMode)}
                  className="mt-2 flex flex-col gap-1"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="append" id="cap-mode-append" />
                    <Label
                      htmlFor="cap-mode-append"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Anexar à track existente
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="replace" id="cap-mode-replace" />
                    <Label
                      htmlFor="cap-mode-replace"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Substituir track (apaga as cues atuais)
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={!cues || cues.length === 0 || parsing}
            onClick={handleConfirm}
          >
            Importar {cues?.length ? `(${cues.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
