import { VideoEditor } from '@/components/apps/video-editor';

export default function EditorVideosPage() {
  return (
    <div className="space-y-6">
       <div>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Editor de Vídeos
        </h1>
        <p className="text-muted-foreground">
          Adicione uma logo e rodapé aos seus vídeos para padronização.
        </p>
      </div>
      <VideoEditor />
    </div>
  );
}
