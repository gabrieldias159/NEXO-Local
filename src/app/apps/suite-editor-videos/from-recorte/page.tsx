'use client';

/**
 * Bootstrap: cria um novo projeto no Suite Editor já com um vídeo do
 * Recortes pré-carregado como asset, e redireciona pra o projeto novo.
 *
 * URL: /apps/suite-editor-videos/from-recorte?folderId=X&videoId=Y
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, AlertCircle } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { ref as storageRef, getDownloadURL } from 'firebase/storage';
import { Timestamp } from 'firebase/firestore';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useFirestore, useStorage, useUser } from '@/firebase';
import { createNewProject, saveProject } from '@/lib/editor/persistence';
import type { MediaAsset, VideoProject, Clip } from '@/lib/editor/types';

const DEFAULT_RESOLUTION = {
  width: 1920,
  height: 1080,
  label: 'Horizontal 16:9 · 1080p',
};

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

async function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.crossOrigin = 'anonymous';
    v.src = url;
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => resolve(0);
    setTimeout(() => resolve(0), 8000);
  });
}

export default function FromRecortePage() {
  const router = useRouter();
  const params = useSearchParams();
  const firestore = useFirestore();
  const storage = useStorage();
  const { user, loading: userLoading } = useUser();

  const folderId = params.get('folderId');
  const videoId = params.get('videoId');

  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!folderId || !videoId) {
      setStatus('error');
      setError('Parâmetros folderId/videoId ausentes na URL.');
      return;
    }
    if (userLoading) return;
    if (!user) {
      setStatus('error');
      setError('Faça login para criar um projeto.');
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus('working');
      try {
        // 1) Lê o doc do vídeo no Recortes.
        const videoDoc = await getDoc(
          doc(firestore, `recortes/${folderId}/videos/${videoId}`),
        );
        if (!videoDoc.exists()) throw new Error('Vídeo não encontrado.');
        const videoData = videoDoc.data() as {
          name?: string;
          filePath: string;
          size?: number;
        };
        if (!videoData.filePath) throw new Error('Vídeo sem filePath.');

        // 2) Cria projeto vazio.
        const project: VideoProject = await createNewProject(
          firestore,
          user.uid,
          videoData.name ?? 'Projeto do Recorte',
          DEFAULT_RESOLUTION,
        );

        // 3) Resolve URL do storage.
        const url = await getDownloadURL(storageRef(storage, videoData.filePath));
        const duration = await probeDuration(url);

        // 4) Cria asset + track + clip.
        const now = Timestamp.now();
        const assetId = genId('asset');
        const asset: MediaAsset = {
          id: assetId,
          name: videoData.name ?? 'video',
          type: 'video',
          source: 'firebase',
          storagePath: videoData.filePath,
          downloadUrl: url,
          size: videoData.size ?? 0,
          duration,
          status: 'ready',
          uploadProgress: 100,
          createdAt: now,
        };
        const trackId = genId('track');
        const clipId = genId('clip');
        const clipDuration = duration > 0 ? duration : 10;
        const clip: Clip = {
          id: clipId,
          assetId,
          trackId,
          startInTimeline: 0,
          endInTimeline: clipDuration,
          startInAsset: 0,
          endInAsset: clipDuration,
          slot: 'full',
          playbackRate: 1,
          transform: {
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            anchorX: 0.5,
            anchorY: 0.5,
            flipH: false,
            flipV: false,
          },
          filters: { brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, grayscale: 0 },
          audio: { volume: 1, muted: false, fadeInDuration: 0, fadeOutDuration: 0, pan: 0 },
          locked: false,
          hidden: false,
        };

        project.assets = [asset];
        project.tracks = [
          {
            id: trackId,
            type: 'video',
            name: 'V1',
            index: 0,
            muted: false,
            locked: false,
            visible: true,
            solo: false,
            height: 64,
            clips: [clip],
          },
        ];
        project.duration = clipDuration;
        // Marca origem para habilitar "Substituir original" no Export.
        project.originRecorte = {
          folderId,
          videoId,
          name: videoData.name ?? 'video',
          originalFilePath: videoData.filePath,
        };

        // 5) Salva projeto preenchido.
        await saveProject(firestore, project);

        // 6) Redireciona pro projeto.
        if (!cancelled) {
          router.replace(`/apps/suite-editor-videos/${project.id}`);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[from-recorte] erro:', err);
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Erro desconhecido.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, videoId, user, userLoading, firestore, storage, router]);

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card>
          <CardContent className="space-y-4 p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Não foi possível criar o projeto</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={() => router.back()}>
                Voltar
              </Button>
              <Button onClick={() => router.push('/apps/suite-editor-videos/projects')}>
                Lista de projetos
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Criando projeto no Suite Editor…</span>
      </div>
    </div>
  );
}
