'use client';

/**
 * Dialog para importar vídeo via URL externa (YouTube/Facebook/direct mp4).
 *
 * Fluxo:
 *   1. Usuário cola URL.
 *   2. Front faz POST em `/api/video/import-url` com `{ url }`.
 *   3. Servidor extrai (FB), faz proxy direto (.mp4) ou avisa 501 (YT).
 *   4. Front recebe stream, vira Blob → ObjectURL → adiciona como asset
 *      local-blob no editor (sem subir pra Storage; download direto pro
 *      navegador do usuário).
 */

import { useState } from 'react';
import { Loader2, Link as LinkIcon, Download } from 'lucide-react';
import { Timestamp } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useEditorStore } from '@/lib/editor/store';

function getMediaDuration(input: { url: string; type: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.src = input.url;
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => reject(new Error('metadata load failed'));
    setTimeout(() => reject(new Error('timeout')), 15000);
  });
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && /\./.test(last)) return decodeURIComponent(last);
    return `${u.hostname.replace(/^www\./, '')}-${Date.now().toString(36)}.mp4`;
  } catch {
    return `import-${Date.now().toString(36)}.mp4`;
  }
}

export function ImportUrlDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const project = useEditorStore((s) => s.project);
  const addAsset = useEditorStore((s) => s.addAsset);
  const updateAsset = useEditorStore((s) => s.updateAsset);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    if (!project) return;
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    const tempId = `asset_url_${Date.now().toString(36)}`;
    const now = {
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    } as unknown as Timestamp;
    addAsset({
      id: tempId,
      name: inferNameFromUrl(u),
      type: 'video',
      source: 'local-blob',
      downloadUrl: '',
      size: 0,
      status: 'uploading',
      uploadProgress: 0,
      createdAt: now,
    });
    try {
      const token = await getAuth().currentUser?.getIdToken();
      const res = await fetch('/api/video/import-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ url: u }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          hint?: string;
          details?: string;
        };
        const msg = err.error ?? `HTTP ${res.status}`;
        const extra = err.details ?? err.hint;
        throw new Error(extra ? `${msg} — ${extra}` : msg);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      let duration = 0;
      try {
        duration = await getMediaDuration({
          url: objectUrl,
          type: blob.type || 'video/mp4',
        });
      } catch {
        // tolerante a metadados
      }
      updateAsset(tempId, {
        downloadUrl: objectUrl,
        size: blob.size,
        duration,
        status: 'ready',
        uploadProgress: 100,
      });
      toast({
        title: 'Vídeo importado',
        description: 'Disponível no MediaBin — arraste pra timeline.',
      });
      setUrl('');
      onOpenChange(false);
    } catch (err) {
      updateAsset(tempId, { status: 'error' });
      toast({
        title: 'Falha ao importar',
        description: err instanceof Error ? err.message : 'Erro desconhecido',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-primary" />
            Importar vídeo de URL
          </DialogTitle>
          <DialogDescription>
            Cola um link público — Facebook/Instagram (post público), mp4
            direto, ou qualquer URL com extensão de vídeo. YouTube é suportado
            em modo best-effort (pode falhar em vídeos protegidos).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="import-url">URL do vídeo</Label>
          <Input
            id="import-url"
            placeholder="https://… (mp4 direto, post público do Facebook)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          <p className="text-[11px] text-muted-foreground">
            O download passa pelo servidor (proxy) e cai no seu navegador como
            um asset local. Pode ficar grande dependendo do vídeo.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={handleImport} disabled={busy || !url.trim()}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Baixando…
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Importar
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
