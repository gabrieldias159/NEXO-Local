'use client';

import React, { useState, useEffect, useRef } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogClose,
  DialogFooter,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  Loader2,
  Video as VideoIcon,
  Download,
  UploadCloud,
  Film,
  Zap,
  Scissors,
  Trash2,
  Save,
  XCircle,
  Folder as FolderIcon,
  ArrowLeft,
  RefreshCw,
  FolderOpen,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useDoc, useFirestore, useMemoFirebase, useStorage, useUser, useCollection } from '@/firebase';
import { doc, Firestore, query, collection, orderBy } from 'firebase/firestore';
import { ref as storageRefUtil, FirebaseStorage, getDownloadURL } from 'firebase/storage';
import { Switch } from '@/components/ui/switch';
import { replaceRecorteVideo } from '@/firebase/admin/actions';
import { RecorteFolder, RecorteVideo, AppearanceConfig } from '@/lib/types';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ScrollArea } from '../ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { truncateFilename, formatTimecode, toDateSafe } from '@/lib/utils';
import Link from 'next/link';

type AspectRatio = '9:16' | '4:5';
type ProcessingPreset = 'ultrafast' | 'medium';

const formatDuration = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

const formatBytes = (bytes: number, decimals = 2) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function SelectRecorteDialog({ open, onOpenChange, onSelect }: { open: boolean, onOpenChange: (open: boolean) => void, onSelect: (video: RecorteVideo) => void }) {
  const firestore = useFirestore() as Firestore;
  const [currentView, setCurrentView] = useState<'folders' | 'videos'>('folders');
  const [selectedFolder, setSelectedFolder] = useState<RecorteFolder | null>(null);

  const foldersQuery = useMemoFirebase(() => query(collection(firestore, 'recortes'), orderBy('createdAt', 'desc')), [firestore]);
  const { data: folders, isLoading: foldersLoading } = useCollection<RecorteFolder>(foldersQuery);

  const videosQuery = useMemoFirebase(() => selectedFolder ? query(collection(firestore, `recortes/${selectedFolder.id}/videos`), orderBy('createdAt', 'desc')) : null, [firestore, selectedFolder]);
  const { data: videos, isLoading: videosLoading } = useCollection<RecorteVideo>(videosQuery);

  useEffect(() => {
    if (open) {
      setCurrentView('folders');
      setSelectedFolder(null);
    }
  }, [open]);

  const handleFolderClick = (folder: RecorteFolder) => {
    setSelectedFolder(folder);
    setCurrentView('videos');
  };

  const handleBackToFolders = () => {
    setSelectedFolder(null);
    setCurrentView('folders');
  };
  
  const handleVideoSelect = (video: RecorteVideo) => {
    onSelect(video);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Selecionar Vídeo do "Recortes"</DialogTitle>
          <DialogDescription>Navegue pelas pastas e escolha um vídeo para editar.</DialogDescription>
        </DialogHeader>
        <div className="min-h-[400px] max-h-[60vh] flex flex-col">
          {currentView === 'videos' && selectedFolder && (
            <div className="flex items-center gap-2 mb-4">
              <Button variant="ghost" size="icon" onClick={handleBackToFolders}><ArrowLeft/></Button>
              <h3 className="font-semibold text-lg">{selectedFolder.name}</h3>
            </div>
          )}
          <ScrollArea className="flex-1">
            {currentView === 'folders' && (
              foldersLoading ? <div className="flex justify-center items-center h-full"><Loader2 className="w-8 h-8 animate-spin" /></div> : (
                <div className="space-y-2">
                  {(folders as RecorteFolder[] || []).map(folder => (
                    <div key={folder.id} onClick={() => handleFolderClick(folder)} className="flex items-center gap-3 p-2 rounded-md hover:bg-accent cursor-pointer">
                      <FolderIcon className="text-primary"/>
                      <div>
                        <p className="font-medium">{folder.name}</p>
                        <p className="text-xs text-muted-foreground">{(() => { const d = toDateSafe(folder.createdAt); return d ? format(d, "dd/MM/yy", { locale: ptBR }) : ''; })()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
            {currentView === 'videos' && (
              videosLoading ? <div className="flex justify-center items-center h-full"><Loader2 className="w-8 h-8 animate-spin" /></div> : (
                <div className="space-y-2">
                  {(videos as RecorteVideo[] || []).map(video => (
                    <div key={video.id} onClick={() => handleVideoSelect(video)} className="flex items-center gap-3 p-2 rounded-md hover:bg-accent cursor-pointer">
                      <VideoIcon className="text-primary"/>
                      <div>
                        <p className="font-medium" title={video.name}>{truncateFilename(video.name, 40, 8)}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(video.size || 0)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TrimTimeline({
  duration,
  trimStart,
  trimEnd,
  currentTime,
  videoRef,
  onTrimChange,
}: {
  duration: number;
  trimStart: number;
  trimEnd: number;
  currentTime: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTrimChange: (start: number, end: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const clientXToTime = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || duration <= 0) return 0;
    const { left, width } = bar.getBoundingClientRect();
    return clamp(((clientX - left) / width) * duration, 0, duration);
  };

  const makeHandlers = (which: 'start' | 'end') => ({
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      if (!(e.currentTarget as HTMLDivElement).hasPointerCapture(e.pointerId)) return;
      const time = clientXToTime(e.clientX);
      if (which === 'start') {
        const newStart = clamp(time, 0, trimEnd - 0.5);
        onTrimChange(newStart, trimEnd);
        if (videoRef.current) videoRef.current.currentTime = newStart;
      } else {
        const newEnd = clamp(time, trimStart + 0.5, duration);
        onTrimChange(trimStart, newEnd);
        if (videoRef.current) videoRef.current.currentTime = newEnd;
      }
    },
    onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    },
    onClick(e: React.MouseEvent) { e.stopPropagation(); },
  });

  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playPct = duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0;
  const trimmed = trimStart > 0.05 || trimEnd < duration - 0.05;

  return (
    <div className="space-y-1.5 pt-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span className="flex items-center gap-1"><Scissors className="h-3 w-3" /> Recorte de início/fim</span>
        {trimmed && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {formatTimecode(trimEnd - trimStart, 30)} selecionados
          </Badge>
        )}
      </div>

      {/* Timeline bar */}
      <div
        ref={barRef}
        className="relative h-9 select-none cursor-pointer rounded-md overflow-visible"
        onClick={e => {
          const time = clientXToTime(e.clientX);
          if (videoRef.current) videoRef.current.currentTime = time;
        }}
      >
        {/* Base track */}
        <div className="absolute inset-0 rounded-md bg-muted overflow-hidden">
          {/* Inactive left */}
          <div className="absolute top-0 left-0 h-full bg-muted-foreground/25" style={{ width: `${startPct}%` }} />
          {/* Active trim region */}
          <div
            className="absolute top-0 h-full bg-primary/20 border-y-2 border-primary/50"
            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          />
          {/* Inactive right */}
          <div className="absolute top-0 right-0 h-full bg-muted-foreground/25" style={{ width: `${100 - endPct}%` }} />
        </div>

        {/* Start handle */}
        <div
          className="absolute top-0 bottom-0 z-20 flex items-center justify-center cursor-ew-resize group"
          style={{ left: `${startPct}%`, transform: 'translateX(-50%)' }}
          {...makeHandlers('start')}
        >
          <div className="w-3 h-full bg-primary rounded-sm flex items-center justify-center group-active:bg-primary/80 transition-colors">
            <div className="space-y-0.5 pointer-events-none">
              <div className="w-0.5 h-1.5 bg-primary-foreground/80 rounded-full mx-auto" />
              <div className="w-0.5 h-1.5 bg-primary-foreground/80 rounded-full mx-auto" />
            </div>
          </div>
        </div>

        {/* End handle */}
        <div
          className="absolute top-0 bottom-0 z-20 flex items-center justify-center cursor-ew-resize group"
          style={{ left: `${endPct}%`, transform: 'translateX(-50%)' }}
          {...makeHandlers('end')}
        >
          <div className="w-3 h-full bg-primary rounded-sm flex items-center justify-center group-active:bg-primary/80 transition-colors">
            <div className="space-y-0.5 pointer-events-none">
              <div className="w-0.5 h-1.5 bg-primary-foreground/80 rounded-full mx-auto" />
              <div className="w-0.5 h-1.5 bg-primary-foreground/80 rounded-full mx-auto" />
            </div>
          </div>
        </div>

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 z-10 w-0.5 bg-white/90 pointer-events-none drop-shadow"
          style={{ left: `${playPct}%` }}
        />
      </div>

      {/* Time labels */}
      <div className="flex items-center justify-between font-mono text-[10px]">
        <span className="text-primary font-semibold tabular-nums">{formatTimecode(trimStart, 30)}</span>
        <span className="text-muted-foreground tabular-nums">{formatTimecode(currentTime, 30)}</span>
        <span className="text-primary font-semibold tabular-nums">{formatTimecode(trimEnd, 30)}</span>
        <span className="text-muted-foreground/50 tabular-nums">/{formatTimecode(duration, 30)}</span>
      </div>
    </div>
  );
}

function SaveToFolderDialog({
  open,
  onOpenChange,
  outputUrl,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  outputUrl: string;
  onSaved: () => void;
}) {
  const { user } = useUser();
  const firestore = useFirestore() as Firestore;
  const storage = useStorage();
  const { toast } = useToast();
  const [view, setView] = useState<'folders' | 'name'>('folders');
  const [selectedFolder, setSelectedFolder] = useState<RecorteFolder | null>(null);
  const [videoName, setVideoName] = useState(`video_editado_${Date.now()}`);
  const [isSaving, setIsSaving] = useState(false);

  const foldersQuery = useMemoFirebase(
    () => query(collection(firestore, 'recortes'), orderBy('createdAt', 'desc')),
    [firestore],
  );
  const { data: folders, isLoading: foldersLoading } = useCollection<RecorteFolder>(foldersQuery);

  useEffect(() => {
    if (open) { setView('folders'); setSelectedFolder(null); setIsSaving(false); }
  }, [open]);

  const handleFolderPick = (folder: RecorteFolder) => {
    setSelectedFolder(folder);
    setVideoName(`video_editado_${new Date().toISOString().slice(0,10)}`);
    setView('name');
  };

  const handleSave = async () => {
    if (!user || !storage || !firestore || !selectedFolder) return;
    setIsSaving(true);
    try {
      const blob = await fetch(outputUrl).then(r => r.blob());
      const file = new File([blob], `${videoName}.mp4`, { type: 'video/mp4' });
      const { uploadRecorteVideo } = await import('@/firebase/admin/actions');
      await uploadRecorteVideo(firestore, storage, selectedFolder.id, user.uid, file, { name: videoName, description: '' });
      toast({ title: 'Salvo!', description: `Vídeo salvo em "${selectedFolder.name}".` });
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Erro ao salvar', description: e.message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            Salvar em pasta — Recortes
          </DialogTitle>
          <DialogDescription>
            {view === 'folders'
              ? 'Selecione a pasta onde o vídeo editado será salvo.'
              : `Pasta: ${selectedFolder?.name}`}
          </DialogDescription>
        </DialogHeader>

        {view === 'folders' ? (
          <div className="min-h-[300px] flex flex-col">
            {foldersLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (folders as RecorteFolder[] || []).length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <FolderIcon className="h-10 w-10" />
                <p className="text-sm">Nenhuma pasta encontrada.</p>
                <p className="text-xs">Crie uma pasta em Recortes primeiro.</p>
              </div>
            ) : (
              <ScrollArea className="flex-1">
                <div className="space-y-1 pr-2">
                  {(folders as RecorteFolder[]).map(folder => (
                    <button
                      key={folder.id}
                      onClick={() => handleFolderPick(folder)}
                      className="w-full flex items-center gap-3 rounded-md p-3 text-left transition-colors hover:bg-accent"
                    >
                      <FolderIcon className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{folder.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(() => { const d = toDateSafe(folder.createdAt); return d ? format(d, "dd/MM/yyyy", { locale: ptBR }) : ''; })()}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="video-save-name">Nome do vídeo</Label>
              <Input
                id="video-save-name"
                value={videoName}
                onChange={e => setVideoName(e.target.value)}
                placeholder="Nome do vídeo"
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setView('folders')} disabled={isSaving}>
                Voltar
              </Button>
              <Button onClick={handleSave} disabled={isSaving || !videoName.trim()}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Salvar
              </Button>
            </DialogFooter>
          </div>
        )}

        {view === 'folders' && (
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancelar</Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

const getAssetData = async (storage: FirebaseStorage, path: string, toast: (options: any) => void): Promise<Uint8Array | null> => {
    if (!path) return null;
    try {
        const assetRef = storageRefUtil(storage, path);
        const downloadUrl = await getDownloadURL(assetRef);
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error(`Network response was not ok for ${path}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
            throw new Error(`Asset at path ${path} is an empty file.`);
        }
        return new Uint8Array(arrayBuffer);
    } catch (e: any) {
        console.error("Falha ao obter o recurso do Storage:", path, e);
         toast({
            title: 'Erro ao Carregar Recurso Visual',
            description: `Não foi possível carregar o recurso "${path.split('/').pop()}". O arquivo pode estar vazio, corrompido ou inacessível.`,
            variant: 'destructive',
        });
        return null;
    }
};

export function VideoEditor() {
  const [ffmpeg, setFfmpeg] = useState<FFmpeg | null>(null);
  const [ffmpegLoading, setFfmpegLoading] = useState(true);
  const [ffmpegLoadFailed, setFfmpegLoadFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const logRef = useRef('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoBytes, setVideoBytes] = useState<Uint8Array | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [preset, setPreset] = useState<ProcessingPreset>('ultrafast');
  const [outputVideoUrl, setOutputVideoUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const [isSourceLoading, setIsSourceLoading] = useState(false);

  const [includeLogo, setIncludeLogo] = useState(true);
  const [includeFooter, setIncludeFooter] = useState(true);
  const [includeEnding, setIncludeEnding] = useState(true);

  const [videoDuration, setVideoDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState(true);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const { toast } = useToast();

  const { user, loading: isUserLoading } = useUser();
  const firestore = useFirestore() as Firestore;
  const storage = useStorage();
  const configRef = useMemoFirebase(() => {
    if (!firestore) return null;
    return doc(firestore, 'configs', 'main');
  }, [firestore]);
  const { data: appearanceConfig, isLoading: isConfigLoading } = useDoc(configRef);

  const [logoData, setLogoData] = useState<Uint8Array | null>(null);
  const [footerData, setFooterData] = useState<Uint8Array | null>(null);
  const [endingData, setEndingData] = useState<Uint8Array | null>(null);
  
  const [originalVideoInfo, setOriginalVideoInfo] = useState<{folderId: string, videoId: string, videoPath: string} | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const [isRecorteDialogOpen, setRecorteDialogOpen] = useState(false);

  const loading = ffmpegLoading || isConfigLoading || isUserLoading;

  useEffect(() => {
    const loadFfmpeg = async () => {
      // Core self-hospedado em /public/ffmpeg/esm PRIMEIRO (mesmo domínio, sem
      // depender de CDN externo). CDN fica só como fallback de resiliência —
      // o local sempre vence, então na prática a CDN nunca é atingida.
      const coreBases = [
        '/ffmpeg/esm',
        'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
      ];
      let lastError: Error | null = null;
      for (const baseURL of coreBases) {
        try {
          const ffmpegInstance = new FFmpeg();
          ffmpegInstance.on('log', ({ message }) => { logRef.current += message + '\n'; });
          ffmpegInstance.on('progress', ({ progress: p }) => {
            setProgress(Math.round(Math.max(0, Math.min(1, p)) * 100));
          });
          await ffmpegInstance.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          });
          setFfmpeg(ffmpegInstance);
          setFfmpegLoading(false);
          return;
        } catch (e) {
          lastError = e as Error;
          console.warn(`FFmpeg load failed from ${baseURL}:`, e);
        }
      }
      console.error('ffmpeg load error (all CDNs failed):', lastError);
      setFfmpegLoadFailed(true);
      setFfmpegLoading(false);
    };
    if (ffmpegLoading && !ffmpeg) {
      loadFfmpeg();
    }
  }, [ffmpeg, ffmpegLoading]);
  
  useEffect(() => {
    if (!appearanceConfig || !storage || !user) return;

    const config = appearanceConfig as AppearanceConfig;
    if (config.videoLogoUrl) getAssetData(storage, config.videoLogoUrl, toast).then(setLogoData);
    if (config.videoFooterUrl) getAssetData(storage, config.videoFooterUrl, toast).then(setFooterData);
    if (config.videoEncerramentoUrl) getAssetData(storage, config.videoEncerramentoUrl, toast).then(setEndingData);

  }, [appearanceConfig, storage, user, toast]);
  
  useEffect(() => {
    return () => {
      if (videoSrc) {
        URL.revokeObjectURL(videoSrc);
      }
    };
  }, [videoSrc]);

  const handleRecorteSelect = async (video: RecorteVideo) => {
    if (!storage) return;

    handleClearVideo();
    setIsSourceLoading(true);
    toast({ title: 'Carregando vídeo do Recorte...', description: 'Aguarde enquanto o vídeo é baixado.' });

    try {
        const videoAsBytes = await getAssetData(storage, video.filePath, toast);
        if (!videoAsBytes) {
            throw new Error("Não foi possível carregar os dados do vídeo do Storage.");
        }

        setVideoBytes(videoAsBytes);
        setVideoFile(null); 
        const folderId = video.filePath.split('/')[1];
        setOriginalVideoInfo({ folderId, videoId: video.id, videoPath: video.filePath });

        const blob = new Blob([new Uint8Array(videoAsBytes)], { type: 'video/mp4' });
        const newVideoUrl = URL.createObjectURL(blob);
        setVideoSrc(newVideoUrl);
    } catch (error: any) {
        console.error("Failed to load video from Recortes:", error);
        toast({
            title: 'Erro ao carregar vídeo',
            description: error.message || 'Não foi possível carregar o vídeo.',
            variant: 'destructive',
        });
    } finally {
        setIsSourceLoading(false);
    }
  };


  const handleClearVideo = () => {
    setVideoFile(null);
    setVideoBytes(null);
    setOutputVideoUrl(null);
    setVideoDuration(0);
    setTrimStart(0);
    setTrimEnd(0);
    setCurrentTime(0);
    if (videoSrc) {
      URL.revokeObjectURL(videoSrc);
    }
    setVideoSrc(null);
    setOriginalVideoInfo(null);
    const fileInput = document.getElementById('video-upload') as HTMLInputElement;
    if(fileInput) fileInput.value = '';
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    handleClearVideo();
    
    setVideoFile(file);
    setVideoBytes(null);
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
    }
  };

  const handleSaveAndReplace = async () => {
    if (!ffmpeg || !outputVideoUrl || !originalVideoInfo || !storage || !firestore || !user) {
         toast({ title: 'Erro', description: 'Recursos necessários para substituição não estão prontos.', variant: 'destructive'});
         return;
    }
    setIsReplacing(true);
    toast({ title: 'Substituindo vídeo...', description: 'Aguarde o envio e a atualização do documento.'});

    try {
        const response = await fetch(outputVideoUrl);
        const blob = await response.blob();
        const newFile = new File([blob], `edited-${Date.now()}.mp4`, { type: 'video/mp4' });

        await replaceRecorteVideo(
            firestore,
            storage,
            originalVideoInfo.folderId,
            originalVideoInfo.videoId,
            originalVideoInfo.videoPath, 
            newFile,
            user.uid
        );

        toast({ title: 'Sucesso!', description: 'O vídeo do recorte foi substituído com sucesso.', variant: 'success'});
        handleClearVideo();
    } catch (error: any) {
        console.error("Failed to replace video:", error);
        toast({ title: 'Erro ao Substituir', description: error.message, variant: 'destructive'});
    } finally {
        setIsReplacing(false);
    }
  };

  const cancelProcessing = () => {
    if (ffmpeg && isProcessing) {
      try {
        ffmpeg.terminate();
      } catch (e) {
        console.warn('Could not terminate ffmpeg:', e);
      }
    }
  };

 const processVideo = async () => {
    const effectiveTrimEnd = trimEnd > 0 ? trimEnd : videoDuration;
    const hasTrim = trimStart > 0.05 || effectiveTrimEnd < videoDuration - 0.05;
    if (!includeLogo && !includeFooter && !includeEnding && !hasTrim) {
        toast({
            title: 'Nenhuma Edição Selecionada',
            description: 'Por favor, defina um recorte ou ative ao menos uma opção de edição (logo, rodapé, vinheta).',
            variant: 'destructive',
        });
        return;
    }

    if (!ffmpeg || (!videoFile && !videoBytes)) {
      toast({
        title: 'Recursos Faltando',
        description: 'Verifique se o vídeo foi enviado.',
        variant: 'destructive',
      });
      return;
    }
    
    const size = videoFile ? videoFile.size : videoBytes ? videoBytes.length : 0;
    if (size > 500 * 1024 * 1024) { 
        toast({
            title: 'Vídeo Muito Grande',
            description: 'O processamento no navegador é limitado. Por favor, use um vídeo com menos de 500MB (aprox. 3-5 minutos).',
            variant: 'destructive'
        })
        return;
    }

    setIsProcessing(true);
    setOutputVideoUrl(null);
    setProgress(0);
    logRef.current = '';

    try {
      const inputData = videoBytes ? videoBytes : await fetchFile(videoFile!);
      if (!inputData) {
        throw new Error('Dados do vídeo de origem não foram encontrados.');
      }
      await ffmpeg.writeFile('input.mp4', inputData);
      
      const command: string[] = ['-i', 'input.mp4'];
      const filterComplexParts: string[] = [];
      let lastVideoOutput = '[0:v]';
      let lastAudioOutput = hasAudio ? '[0:a]' : undefined;
      let nextInputIndex = 1;

      if (hasTrim) {
        filterComplexParts.push(`[0:v]trim=${trimStart}:${effectiveTrimEnd},setpts=PTS-STARTPTS[v_trimmed]`);
        lastVideoOutput = '[v_trimmed]';
        if (lastAudioOutput) {
          filterComplexParts.push(`[0:a]atrim=${trimStart}:${effectiveTrimEnd},asetpts=PTS-STARTPTS[a_trimmed]`);
          lastAudioOutput = '[a_trimmed]';
        }
      }

      const targetResolution = aspectRatio === '9:16' ? '1080:1920' : '1080:1350';
      const [targetW, targetH] = targetResolution.split(':').map(Number);
      filterComplexParts.push(`${lastVideoOutput}scale=${targetW}:-2,crop=w=min(iw\\,${targetW}):h=min(ih\\,${targetH}),pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2[v_scaled]`);
      lastVideoOutput = '[v_scaled]';
      
      if (includeLogo && logoData) {
        await ffmpeg.writeFile('logo.png', logoData.slice());
        command.push('-i', 'logo.png');
        filterComplexParts.push(`${lastVideoOutput}[${nextInputIndex}:v]overlay=W-w-30:30[v_logo]`);
        lastVideoOutput = '[v_logo]';
        nextInputIndex++;
      }

      if (includeFooter && footerData) {
        await ffmpeg.writeFile('footer.png', footerData.slice());
        command.push('-i', 'footer.png');
        filterComplexParts.push(`${lastVideoOutput}[${nextInputIndex}:v]overlay=(W-w)/2:H-h[v_footer]`);
        lastVideoOutput = '[v_footer]';
        nextInputIndex++;
      }
      
      if (includeEnding && endingData) {
        await ffmpeg.writeFile('ending.mp4', endingData.slice());
        command.push('-i', 'ending.mp4');
        const endingInputIndex = nextInputIndex;
        nextInputIndex++;

        filterComplexParts.push(`[${endingInputIndex}:v]setpts=PTS-STARTPTS,scale=${targetW}:-2,crop=w=min(iw\\,${targetW}):h=min(ih\\,${targetH}),pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2[v_ending_scaled]`);
        filterComplexParts.push(`${lastVideoOutput}[v_ending_scaled]concat=n=2:v=1:a=0[v_out]`);
        lastVideoOutput = '[v_out]';
        
        if (lastAudioOutput) {
            filterComplexParts.push(`${lastAudioOutput}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a_main_norm_final]`);
            filterComplexParts.push(`[${endingInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a_ending_normalized]`);
            filterComplexParts.push(`[a_main_norm_final][a_ending_normalized]concat=n=2:v=0:a=1[a_out]`);
            lastAudioOutput = '[a_out]';
        }
      }
      
      if (filterComplexParts.length > 0) {
        command.push('-filter_complex', filterComplexParts.join(';'));
      }
      command.push('-map', lastVideoOutput);
      if (lastAudioOutput) {
        command.push('-map', lastAudioOutput);
      } else {
        command.push('-an');
      }
      
      command.push('-preset', preset, 'output.mp4');

      await ffmpeg.exec(command);

      const data = await ffmpeg.readFile('output.mp4');
      const outputBytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      const url = URL.createObjectURL(new Blob([outputBytes], { type: 'video/mp4' }));
      setOutputVideoUrl(url);

      toast({
        title: 'Sucesso!',
        description: 'Seu vídeo foi processado.',
        variant: 'success',
      });
    } catch (error: any) {
      if (error?.message?.includes('terminat')) {
        toast({
            title: 'Processamento Cancelado',
            description: 'A edição do vídeo foi interrompida.',
        });
      } else {
        console.error('ffmpeg processing error:', error);
        console.error('ffmpeg logs:', logRef.current);
        toast({
          title: 'Erro no Processamento',
          description:
            (error as Error).message || 'Ocorreu um erro ao editar o vídeo. Verifique o console para detalhes.',
          variant: 'destructive',
        });
      }
    } finally {
      setIsProcessing(false);
      setProgress(0);
    }
  };

  if (loading) {
    return (
      <Card className="flex flex-col items-center justify-center text-center p-8 border-dashed min-h-[400px]">
        <Loader2 className="h-12 w-12 mx-auto animate-spin text-primary" />
        <CardTitle className="mt-4">Carregando Editor de Vídeo</CardTitle>
        <CardDescription>
          Isso pode levar um momento. O motor de edição está sendo preparado.
        </CardDescription>
      </Card>
    );
  }

  const config = appearanceConfig as AppearanceConfig;

  return (
    <>
      <SelectRecorteDialog open={isRecorteDialogOpen} onOpenChange={setRecorteDialogOpen} onSelect={handleRecorteSelect} />
      {outputVideoUrl && (
        <SaveToFolderDialog
          open={isSaveDialogOpen}
          onOpenChange={setIsSaveDialogOpen}
          outputUrl={outputVideoUrl}
          onSaved={() => setIsSaveDialogOpen(false)}
        />
      )}
      <div className="grid gap-8 md:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Configurações do Vídeo</CardTitle>
            <CardDescription>
              Envie seu vídeo e ajuste as configurações de processamento.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-grow space-y-6">
            {ffmpegLoadFailed && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 flex items-center justify-between gap-4 mb-2">
                <div>
                  <p className="font-semibold text-sm text-destructive">Motor de edição não carregado</p>
                  <p className="text-xs text-muted-foreground">Falha ao inicializar o FFmpeg. Verifique sua conexão.</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => { setFfmpegLoadFailed(false); setFfmpegLoading(true); }}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Tentar novamente
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-base font-semibold">1. Vídeo de Origem</Label>
              <div className="border-2 border-dashed rounded-lg p-4 min-h-[150px] flex flex-col items-center justify-center text-center">
                  {isSourceLoading ? (
                      <>
                          <Loader2 className="h-8 w-8 animate-spin text-primary" />
                          <p className="mt-2 font-semibold">Carregando vídeo...</p>
                          <p className="text-sm text-muted-foreground">Aguarde, por favor.</p>
                      </>
                  ) : (videoFile || videoBytes) && videoSrc ? (
                      <div className="w-full space-y-2">
                          <video
                            ref={videoRef}
                            src={videoSrc}
                            controls
                            className="w-full rounded-md max-h-52"
                            preload="metadata"
                            onLoadedMetadata={() => {
                              if (videoRef.current) {
                                const dur = videoRef.current.duration;
                                setVideoDuration(dur);
                                setTrimStart(0);
                                setTrimEnd(dur);
                                const vn = videoRef.current as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean; audioTracks?: { length: number } };
                                // P2-20: default true; so derruba para false com evidencia POSITIVA de ausencia.
                                // - audioTracks (Firefox/Safari) e confiavel ja na metadata: length === 0 => sem audio.
                                // - mozHasAudio (Firefox) e um boolean confiavel.
                                // - webkitAudioDecodedByteCount (Chrome) vale 0 na metadata porque nada foi decodificado
                                //   ainda; usar 0 como prova de "sem audio" gera falso-negativo, entao NAO o usamos aqui.
                                let detectedHasAudio = true;
                                if (vn.audioTracks && typeof vn.audioTracks.length === 'number') {
                                  detectedHasAudio = vn.audioTracks.length > 0;
                                } else if (typeof vn.mozHasAudio === 'boolean') {
                                  detectedHasAudio = vn.mozHasAudio;
                                }
                                setHasAudio(detectedHasAudio);
                              }
                            }}
                            onTimeUpdate={() => {
                              if (!videoRef.current) return;
                              const ct = videoRef.current.currentTime;
                              setCurrentTime(ct);
                              const end = trimEnd > 0 ? trimEnd : videoDuration;
                              if (ct < trimStart) { videoRef.current.currentTime = trimStart; }
                              if (ct >= end - 0.05) {
                                videoRef.current.pause();
                                videoRef.current.currentTime = trimStart;
                              }
                            }}
                          />
                          {videoDuration > 0 && (
                            <TrimTimeline
                              duration={videoDuration}
                              trimStart={trimStart}
                              trimEnd={trimEnd > 0 ? trimEnd : videoDuration}
                              currentTime={currentTime}
                              videoRef={videoRef}
                              onTrimChange={(s, e) => { setTrimStart(s); setTrimEnd(e); }}
                            />
                          )}
                          {/* Frame-by-frame nav (1/30s por step) */}
                          {videoDuration > 0 && (
                            <div className="flex items-center justify-center gap-1.5 pt-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() => {
                                  if (!videoRef.current) return;
                                  videoRef.current.pause();
                                  videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1/30);
                                }}
                                title="Frame anterior"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                <span className="text-[10px] ml-1">-1f</span>
                              </Button>
                              <span className="text-[10px] font-mono text-muted-foreground tabular-nums min-w-[60px] text-center">
                                {formatTimecode(currentTime, 30)}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() => {
                                  if (!videoRef.current) return;
                                  videoRef.current.pause();
                                  videoRef.current.currentTime = Math.min(videoDuration, videoRef.current.currentTime + 1/30);
                                }}
                                title="Próximo frame"
                              >
                                <span className="text-[10px] mr-1">+1f</span>
                                <ChevronRight className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-2 pt-1">
                              <p className="text-xs text-muted-foreground truncate min-w-0" title={videoFile?.name || originalVideoInfo?.videoPath}>
                                  {truncateFilename(videoFile?.name || originalVideoInfo?.videoPath.split('/').pop(), 36, 10)}
                              </p>
                              <Button size="sm" variant="destructive" onClick={handleClearVideo} className="shrink-0">
                                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                                  Remover
                              </Button>
                          </div>
                      </div>
                  ) : (
                      <>
                          <UploadCloud className="h-8 w-8 text-muted-foreground" />
                          <p className="mt-2 font-semibold">Arraste um vídeo ou selecione abaixo</p>
                          <p className="text-sm text-muted-foreground">MP4 ou QuickTime, até 500MB</p>
                          <Input id="video-upload" type="file" accept="video/mp4,video/quicktime,video/mov" onChange={handleVideoUpload} className="sr-only" />
                          <div className="flex items-center gap-4 mt-4">
                              <label htmlFor="video-upload" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 cursor-pointer">
                                  Selecionar Arquivo
                              </label>
                              <span className="text-muted-foreground">ou</span>
                              <Button type="button" variant="outline" onClick={() => setRecorteDialogOpen(true)}>
                                  Selecionar Recorte
                              </Button>
                          </div>
                      </>
                  )}
              </div>
            </div>

            <div className="space-y-4">
              <Label className="text-base font-semibold">2. Opções de Edição</Label>
              <div className="grid gap-4 rounded-md border p-4">
                  <div className="flex items-center justify-between">
                      <Label htmlFor="include-logo" className="flex flex-col space-y-1 pr-4">
                          <span>Incluir Logo</span>
                          <span className="font-normal leading-snug text-muted-foreground text-xs">
                              Adiciona a logo no canto superior direito.
                          </span>
                      </Label>
                      <Switch
                          id="include-logo"
                          checked={includeLogo}
                          onCheckedChange={setIncludeLogo}
                          disabled={!logoData}
                          aria-label="Incluir Logo"
                      />
                  </div>
                   <div className="flex items-center justify-between">
                      <Label htmlFor="include-footer" className="flex flex-col space-y-1 pr-4">
                          <span>Incluir Rodapé</span>
                          <span className="font-normal leading-snug text-muted-foreground text-xs">
                              Adiciona o rodapé na parte inferior.
                          </span>
                      </Label>
                      <Switch
                          id="include-footer"
                          checked={includeFooter}
                          onCheckedChange={setIncludeFooter}
                          disabled={!footerData}
                          aria-label="Incluir Rodapé"
                      />
                  </div>
                   <div className="flex items-center justify-between">
                      <Label htmlFor="include-ending" className="flex flex-col space-y-1 pr-4">
                          <span>Incluir Vinheta Final</span>
                          <span className="font-normal leading-snug text-muted-foreground text-xs">
                             Adiciona o vídeo de encerramento ao final.
                          </span>
                      </Label>
                      <Switch
                          id="include-ending"
                          checked={includeEnding}
                          onCheckedChange={setIncludeEnding}
                          disabled={!endingData}
                          aria-label="Incluir Vinheta Final"
                      />
                  </div>
              </div>
               <p className="text-sm text-muted-foreground">
                  Os recursos visuais (logo, rodapé, vinheta) são gerenciados em{' '}
                  <Link href="/admin/appearance" className="underline">
                   Identidade Visual
                  </Link>
                  .
                </p>
            </div>

            <div className="space-y-4">
              <Label className="text-base font-semibold">3. Ajustes de Saída</Label>
              <div className="grid gap-4 rounded-md border p-4">
                <div className="space-y-2">
                  <Label>Motor de Processamento</Label>
                  <Input value="FFmpeg" disabled />
                   <p className="text-xs text-muted-foreground">
                    O aplicativo utiliza FFmpeg para processamento de vídeo no navegador.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="preset-select">Modo de Processamento</Label>
                  <Select
                    value={preset}
                    onValueChange={(v: ProcessingPreset) => setPreset(v)}
                  >
                    <SelectTrigger id="preset-select">
                      <SelectValue placeholder="Modo" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ultrafast">
                        <div className="flex items-center gap-2">
                          <Zap />
                          <span>Rápido (Padrão)</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="medium">
                        <div className="flex items-center gap-2">
                          <Film />
                          <span>Qualidade (Mais Lento)</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    O modo "Qualidade" é mais lento, mas resulta em um arquivo final menor.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="aspect-ratio">Formato de Saída</Label>
                  <Select
                    value={aspectRatio}
                    onValueChange={(v: AspectRatio) => setAspectRatio(v)}
                  >
                    <SelectTrigger id="aspect-ratio">
                      <SelectValue placeholder="Formato" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="9:16">9:16 (Stories/Reels)</SelectItem>
                      <SelectItem value="4:5">4:5 (Feed Vertical)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              onClick={processVideo}
              disabled={
                isProcessing ||
                ffmpegLoadFailed ||
                (!videoFile && !videoBytes) ||
                (includeLogo && !logoData) ||
                (includeFooter && !footerData) ||
                (includeEnding && !endingData)
              }
              className="w-full"
              size="lg"
            >
              {isProcessing ? (
                <Loader2 className="mr-2 animate-spin" />
              ) : (
                <VideoIcon className="mr-2" />
              )}
              {isProcessing ? 'Processando Vídeo...' : '4. Gerar Vídeo'}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resultado</CardTitle>
            <CardDescription>
              O vídeo processado aparecerá aqui.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center min-h-[300px] bg-muted/50 rounded-lg">
            {isProcessing ? (
              <div className="w-full px-4 text-center">
                <p className="text-sm text-muted-foreground mb-2">
                  Processando, por favor aguarde...
                </p>
                <Progress value={progress} className="w-full mb-2" />
                <p className="text-xs text-muted-foreground mb-4">
                  {progress > 0 ? `${progress}% concluído` : 'Iniciando...'}
                </p>
                <Button variant="destructive" size="sm" onClick={cancelProcessing}>
                  <XCircle className="mr-2 h-4 w-4" />
                  Cancelar
                </Button>
              </div>
            ) : outputVideoUrl ? (
              <div className="space-y-3 w-full">
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  Vídeo processado com sucesso!
                </div>
                <video src={outputVideoUrl} controls className="w-full rounded-md" />
                <div className="flex flex-col gap-2">
                  <Button asChild className="w-full">
                    <a href={outputVideoUrl} download="video_editado.mp4">
                      <Download className="mr-2 h-4 w-4" />
                      Baixar Vídeo
                    </a>
                  </Button>
                  <Button variant="outline" className="w-full" onClick={() => setIsSaveDialogOpen(true)}>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Salvar em pasta (Recortes)
                  </Button>
                  {originalVideoInfo && (
                    <Button onClick={handleSaveAndReplace} disabled={isReplacing} variant="secondary" className="w-full">
                      {isReplacing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Substituir original
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <UploadCloud className="mx-auto h-12 w-12" />
                <p>Aguardando processamento</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
