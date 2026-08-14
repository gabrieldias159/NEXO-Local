'use client';

import { useState, useEffect } from 'react';
import { Loader2, Folder as FolderIcon, Video as VideoIcon, ArrowLeft } from 'lucide-react';
import { query, collection, orderBy } from 'firebase/firestore';
import { useFirestore, useMemoFirebase, useCollection } from '@/firebase';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RecorteFolder, RecorteVideo } from '@/lib/types';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const formatBytes = (bytes: number) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${sizes[i]}`;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (video: RecorteVideo) => void;
}

export function RecortePickerDialog({ open, onOpenChange, onSelect }: Props) {
  const firestore = useFirestore();
  const [view, setView] = useState<'folders' | 'videos'>('folders');
  const [selectedFolder, setSelectedFolder] = useState<RecorteFolder | null>(null);

  useEffect(() => {
    if (open) {
      setView('folders');
      setSelectedFolder(null);
    }
  }, [open]);

  const foldersQuery = useMemoFirebase(
    () => query(collection(firestore, 'recortes'), orderBy('createdAt', 'desc')),
    [firestore],
  );
  const { data: folders, isLoading: foldersLoading } = useCollection<RecorteFolder>(foldersQuery);

  const videosQuery = useMemoFirebase(
    () =>
      selectedFolder
        ? query(collection(firestore, `recortes/${selectedFolder.id}/videos`), orderBy('createdAt', 'desc'))
        : null,
    [firestore, selectedFolder],
  );
  const { data: videos, isLoading: videosLoading } = useCollection<RecorteVideo>(videosQuery);

  const handleVideoSelect = (video: RecorteVideo) => {
    onSelect(video);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar do Recortes</DialogTitle>
          <DialogDescription>Escolha um vídeo da sua biblioteca de recortes.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[360px] flex-col">
          {view === 'videos' && selectedFolder && (
            <div className="mb-3 flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => { setView('folders'); setSelectedFolder(null); }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="font-semibold">{selectedFolder.name}</span>
            </div>
          )}

          <ScrollArea className="flex-1">
            {view === 'folders' && (
              foldersLoading ? (
                <div className="flex h-full items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-1">
                  {(folders as RecorteFolder[] ?? []).map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => { setSelectedFolder(folder); setView('videos'); }}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                    >
                      <FolderIcon className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{folder.name}</p>
                        {folder.createdAt && (
                          <p className="text-xs text-muted-foreground">
                            {format(
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              typeof (folder.createdAt as any).toDate === 'function'
                                ? (folder.createdAt as any).toDate()
                                : (folder.createdAt as unknown as Date),
                              'dd/MM/yy',
                              { locale: ptBR },
                            )}
                          </p>
                        )}
                      </div>
                    </button>
                  ))}
                  {!foldersLoading && (folders as RecorteFolder[] ?? []).length === 0 && (
                    <p className="py-10 text-center text-sm text-muted-foreground">Nenhuma pasta encontrada.</p>
                  )}
                </div>
              )
            )}

            {view === 'videos' && (
              videosLoading ? (
                <div className="flex h-full items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-1">
                  {(videos as RecorteVideo[] ?? []).map((video) => (
                    <button
                      key={video.id}
                      onClick={() => handleVideoSelect(video)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                    >
                      <VideoIcon className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{video.name}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(video.size ?? 0)}</p>
                      </div>
                    </button>
                  ))}
                  {!videosLoading && (videos as RecorteVideo[] ?? []).length === 0 && (
                    <p className="py-10 text-center text-sm text-muted-foreground">Nenhum vídeo nesta pasta.</p>
                  )}
                </div>
              )
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
