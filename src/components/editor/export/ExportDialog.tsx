'use client';

/**
 * Dialog de exportação do Suite Editor de Vídeos.
 *
 * Estratégia "client-first" (docs/editor/03_DEPLOY_STRATEGY.md):
 *
 *  - Vídeos curtos/leves → render no browser via FFmpeg.wasm (zero custo).
 *  - Vídeos pesados / com captions queimadas → fallback para Cloud Function.
 *
 * O dialog mostra qual estratégia será usada antes do user clicar em
 * "Exportar", incluindo a razão se o caminho client foi descartado.
 *
 * Fluxo:
 * 1. Usuário escolhe `resolution`, `format`, `quality`, `burnCaptions`.
 * 2. Calcula `eligibility` + `browserSupport` em tempo real.
 * 3. Ao clicar em "Exportar":
 *    - Path client: usa `useClientRender` → Blob → download.
 *    - Path cloud: cria `RenderJob` no Firestore + onSnapshot pra progresso.
 * 4. Em `error`, mostra a mensagem.
 *
 * O Dialog é controlado pelo store (`ui.exportDialogOpen`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
} from 'firebase/firestore';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { ToastAction } from '@/components/ui/toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditorStore } from '@/lib/editor/store';
import { useCollection, useFirestore, useMemoFirebase, useStorage, useUser } from '@/firebase';
import {
  browserSupportsClientRender,
  checkClientRenderEligibility,
  selectRenderTier,
  useClientRender,
} from '@/lib/editor/render-client';
import { useToast } from '@/hooks/use-toast';
import { uploadRecorteVideo, replaceRecorteVideo } from '@/firebase/admin/actions';
import { EditorIcons } from '../shared/EditorIcons';
import type { ExportSettings, RenderJob, RenderTier } from '@/lib/editor/types';
import type { RecorteFolder } from '@/lib/types';

type LocalSettings = {
  resolution: ExportSettings['resolution'];
  format: ExportSettings['format'];
  quality: ExportSettings['quality'];
  burnCaptions: boolean;
  includeLogo: boolean;
  includeFooter: boolean;
  includeEnding: boolean;
};

const DEFAULT_SETTINGS: LocalSettings = {
  resolution: '1080p',
  format: 'mp4',
  quality: 'medium',
  burnCaptions: false,
  includeLogo: false,
  includeFooter: false,
  includeEnding: false,
};

type RemoteJob = Partial<RenderJob> & { error?: string };

type RenderStrategy = 'client' | 'cloud';

/** Modo de destino do vídeo renderizado (Recortes ou apenas download). */
type SaveMode = 'download' | 'new-copy' | 'replace';

export function ExportDialog() {
  const open = useEditorStore((s) => s.ui.exportDialogOpen);
  const setOpen = useEditorStore((s) => s.setExportDialogOpen);
  const project = useEditorStore((s) => s.project);
  const projectOverlays = useEditorStore((s) => s.project?.overlays);
  const originRecorte = useEditorStore((s) => s.project?.originRecorte);
  const createRenderJob = useEditorStore((s) => s.createRenderJob);

  const firestore = useFirestore();
  const storage = useStorage();
  const { user } = useUser();
  const { toast } = useToast();

  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [remoteJob, setRemoteJob] = useState<RemoteJob | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [destinationFolderId, setDestinationFolderId] = useState('');
  const [saveMode, setSaveMode] = useState<SaveMode>('download');
  // Refs para evitar disparar toasts duplicados quando o snapshot atualizar.
  const lastNotifiedStatusRef = useRef<string | null>(null);
  const clientUploadStartedRef = useRef(false);

  const foldersQuery = useMemoFirebase(
    () => (firestore ? query(collection(firestore, 'recortes'), orderBy('createdAt', 'desc')) : null),
    [firestore],
  );
  const { data: folders } = useCollection<RecorteFolder>(foldersQuery);

  // Estado do path client-side
  const clientRender = useClientRender();
  const [clientBlobUrl, setClientBlobUrl] = useState<string | null>(null);
  // Falha de reprodução do preview inline (mostra dica de Baixar/Abrir).
  const [previewError, setPreviewError] = useState(false);
  // Escolha manual do motor (sobrescreve a heurística automática).
  // RENDER 100% LOCAL. O NEXO-Local existe para nao gastar nuvem: renderizar
  // no servidor sairia do proposito. A escolha de motor foi removida da UI e
  // o valor fica fixo em 'client' (FFmpeg.wasm no navegador).
  const [engineChoice] = useState<'client'>('client');

  // Limpa estado quando o dialog fecha (mas mantém durante render).
  useEffect(() => {
    if (!open && remoteJob?.status !== 'rendering' && !clientRender.isRendering) {
      setActiveJobId(null);
      setRemoteJob(null);
      setSubmitError(null);
      setDestinationFolderId('');
      setSaveMode('download');
      lastNotifiedStatusRef.current = null;
      clientUploadStartedRef.current = false;
      setPreviewError(false);
      // Reseta o resultado do render LOCAL: sem isto, reabrir o dialog mostrava
      // "Render concluído" com o blob da exportação anterior. Revoga a URL
      // (libera memória) e zera o estado para voltar ao formulário limpo.
      setClientBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
  }, [open, remoteJob?.status, clientRender.isRendering]);

  // Inicializa saveMode quando abre, baseado em originRecorte
  useEffect(() => {
    if (open) {
      if (originRecorte) {
        setSaveMode('replace');
        setDestinationFolderId(originRecorte.folderId);
      } else {
        setSaveMode('download');
        setDestinationFolderId('');
      }
    }
  }, [open, originRecorte]);

  // Pré-preenche sobreposições a partir das configurações do projeto ao abrir.
  useEffect(() => {
    if (open && projectOverlays) {
      setSettings((s) => ({
        ...s,
        includeLogo: projectOverlays.logo ?? false,
        includeFooter: projectOverlays.footer ?? false,
        includeEnding: projectOverlays.ending ?? false,
      }));
    }
  }, [open, projectOverlays]);

  // Revoga blob URL ao desmontar
  useEffect(() => {
    return () => {
      if (clientBlobUrl) URL.revokeObjectURL(clientBlobUrl);
    };
  }, [clientBlobUrl]);

  // Listener no documento `renderJobs/{id}` para progresso real-time (Cloud).
  useEffect(() => {
    if (!activeJobId || !firestore) return;
    const ref = doc(firestore, 'renderJobs', activeJobId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as RemoteJob;
        setRemoteJob(data);

        // Toast persistente quando muda pra complete/error/cancelled.
        const status = data.status;
        if (
          status &&
          status !== lastNotifiedStatusRef.current &&
          (status === 'complete' || status === 'error' || status === 'cancelled')
        ) {
          lastNotifiedStatusRef.current = status;
          if (status === 'complete') {
            const url = data.outputUrl;
            toast({
              title: 'Render concluído!',
              description: data.savedVideoId
                ? `Vídeo salvo em Recortes.${url ? ' Clique pra abrir.' : ''}`
                : 'Vídeo pronto pra download.',
              variant: 'success',
              action: url ? (
                <ToastAction
                  altText="Abrir vídeo"
                  onClick={() => window.open(url, '_blank')}
                >
                  Abrir
                </ToastAction>
              ) : undefined,
            });
          } else if (status === 'error') {
            toast({
              title: 'Falha no render',
              description: data.error ?? 'Erro desconhecido durante o render.',
              variant: 'destructive',
            });
          } else if (status === 'cancelled') {
            toast({
              title: 'Render cancelado',
              description: 'O processamento foi interrompido.',
            });
          }
        }
      },
      (err) => {
        setSubmitError(err.message);
        toast({
          title: 'Erro ao acompanhar render',
          description: err.message,
          variant: 'destructive',
        });
      },
    );
    return () => unsub();
  }, [activeJobId, firestore, toast]);

  // Avalia estratégia em tempo real (re-roda quando settings/project mudam)
  const exportSettings: ExportSettings = useMemo(
    () => ({
      resolution: settings.resolution,
      format: settings.format,
      quality: settings.quality,
      burnCaptions: settings.burnCaptions,
      includeLogo: settings.includeLogo,
      includeFooter: settings.includeFooter,
      includeEnding: settings.includeEnding,
    }),
    [settings],
  );

  const strategyInfo = useMemo(() => {
    if (!project) {
      return null;
    }
    const eligibility = checkClientRenderEligibility(project, exportSettings);
    const browser = browserSupportsClientRender();
    // Sem fallback para nuvem: se o projeto passar dos limites do
    // FFmpeg.wasm, avisamos o que reduzir em vez de mandar pro servidor
    // pelas costas do usuario.
    const strategy: RenderStrategy = 'client';
    return { strategy, autoStrategy: strategy, eligibility, browser };
  }, [project, exportSettings, engineChoice]);

  const isCloudRendering = useMemo(() => {
    if (!remoteJob) return false;
    return remoteJob.status === 'pending' || remoteJob.status === 'rendering';
  }, [remoteJob]);

  const isRendering = isSubmitting || isCloudRendering || clientRender.isRendering;
  const isComplete =
    remoteJob?.status === 'complete' || (!!clientBlobUrl && !clientRender.isRendering);
  const isError =
    !!submitError || remoteJob?.status === 'error' || !!clientRender.error;
  const errorMessage = submitError ?? remoteJob?.error ?? clientRender.error ?? null;

  const progressValue = clientRender.isRendering
    ? clientRender.progress
    : (remoteJob?.progress ?? 0);

  async function handleExport() {
    setSubmitError(null);
    if (!project) {
      setSubmitError('Nenhum projeto carregado.');
      return;
    }
    if (!user) {
      setSubmitError('Você precisa estar autenticado para exportar.');
      return;
    }

    const strategy: RenderStrategy = 'client';

    setSubmitting(true);
    try {
      if (strategy === 'client') {
        await runClientRender();
      } else {
        await runCloudRender();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function runClientRender() {
    if (!project) return;
    // Registra job local com engine `ffmpeg-wasm` para auditoria/UX.
    if (user) {
      createRenderJob(exportSettings, 'ffmpeg-wasm', user.uid);
    }
    const blob = await clientRender.render(project, exportSettings);
    const url = URL.createObjectURL(blob);
    setClientBlobUrl(url);

    // Save mode "replace" ou "new-copy" no client → faz upload pra Recortes.
    if (saveMode !== 'download' && user && firestore && storage && !clientUploadStartedRef.current) {
      clientUploadStartedRef.current = true;
      try {
        const fileName = `${project.name || 'render'}.${settings.format}`;
        const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });

        if (saveMode === 'replace' && originRecorte?.folderId && originRecorte?.videoId && originRecorte?.originalFilePath) {
          await replaceRecorteVideo(
            firestore,
            storage,
            originRecorte.folderId,
            originRecorte.videoId,
            originRecorte.originalFilePath,
            file,
            user.uid,
          );
          toast({
            title: 'Vídeo substituído!',
            description: `O vídeo original em "${originRecorte.name ?? 'Recortes'}" foi atualizado.`,
            variant: 'success',
          });
        } else if (saveMode === 'new-copy' && destinationFolderId) {
          await uploadRecorteVideo(firestore, storage, destinationFolderId, user.uid, file, {
            name: project.name || 'render',
            description: `Render do projeto "${project.name}"`,
          });
          toast({
            title: 'Vídeo salvo em Recortes!',
            description: 'Nova cópia adicionada à pasta selecionada.',
            variant: 'success',
          });
        } else {
          toast({
            title: 'Render concluído',
            description: 'Vídeo pronto pra download.',
            variant: 'success',
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          title: 'Falha ao salvar em Recortes',
          description: msg + ' — você ainda pode baixar pelo botão.',
          variant: 'destructive',
        });
      }
    } else if (saveMode === 'download') {
      toast({
        title: 'Render concluído',
        description: 'Vídeo pronto pra download.',
        variant: 'success',
      });
    }
  }

  async function runCloudRender() {
    if (!project || !user) return;
    // `runClientRender` já guarda `firestore && storage`; aqui o cloud usa
    // `doc(firestore,...)`/`setDoc` direto, então protegemos contra firestore
    // nulo (Firebase ainda não inicializado) para não lançar um TypeError opaco.
    if (!firestore) {
      throw new Error('Conexão com o servidor indisponível. Tente novamente.');
    }

    const tierResult = selectRenderTier(project, exportSettings);

    const job = createRenderJob(exportSettings, 'cloud-ffmpeg', user.uid);
    if (!job) throw new Error('Falha ao criar job local.');

    const isReplace = saveMode === 'replace' && originRecorte;
    const isNewCopy = saveMode === 'new-copy' && destinationFolderId;

    const ref = doc(firestore, 'renderJobs', job.id);
    // Auto-delete via TTL Firestore: 14 dias apos criacao. O trigger
    // onRenderJobDeleted (Cloud Function) cuida de apagar o arquivo do Storage.
    const TTL_MS = 14 * 24 * 60 * 60 * 1000;
    await setDoc(ref, {
      id: job.id,
      projectId: job.projectId,
      ownerUid: job.ownerUid,
      engine: job.engine,
      tier: tierResult.tier,
      status: 'pending',
      progress: 0,
      exportSettings: job.exportSettings,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
      ...(isReplace
        ? { replaceFolderId: originRecorte!.folderId, replaceVideoId: originRecorte!.videoId }
        : isNewCopy
          ? { destinationFolderId }
          : {}),
    });

    setActiveJobId(job.id);

    // Toast imediato — confirma que o job foi enfileirado.
    toast({
      title: 'Render iniciado',
      description: isReplace
        ? `Vai substituir o vídeo original ao terminar. Tier: ${tierResult.tier}.`
        : isNewCopy
          ? `Vai salvar como nova cópia em Recortes. Tier: ${tierResult.tier}.`
          : `Processando no servidor. Tier: ${tierResult.tier}. Você pode fechar esta janela.`,
    });
  }

  function handleClose() {
    setOpen(false);
  }

  const downloadFileName = `${project?.name ?? 'video'}.${settings.format}`;

  return (
    <Dialog open={open} onOpenChange={(v) => setOpen(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Exportar vídeo</DialogTitle>
          <DialogDescription>
            Renderiza o projeto no seu próprio navegador e disponibiliza para
            download. Todo o processamento é local — nada é enviado para
            servidor e não há custo de nuvem.
          </DialogDescription>
        </DialogHeader>

        {!isRendering && !isComplete && (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="export-resolution">Resolução</Label>
              <Select
                value={settings.resolution}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, resolution: v as LocalSettings['resolution'] }))
                }
              >
                <SelectTrigger id="export-resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                  <SelectItem value="720p">720p (HD)</SelectItem>
                  <SelectItem value="480p">480p (SD)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="export-format">Formato</Label>
              <Select
                value={settings.format}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, format: v as LocalSettings['format'] }))
                }
              >
                <SelectTrigger id="export-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp4">MP4 (H.264)</SelectItem>
                  <SelectItem value="webm">WebM (VP9)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="export-quality">Qualidade</Label>
              <Select
                value={settings.quality}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, quality: v as LocalSettings['quality'] }))
                }
              >
                <SelectTrigger id="export-quality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Baixa (arquivo menor)</SelectItem>
                  <SelectItem value="medium">Média (recomendado)</SelectItem>
                  <SelectItem value="high">Alta (melhor qualidade)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div className="grid gap-0.5">
                <Label htmlFor="export-burn">Queimar legendas no vídeo</Label>
                <p className="text-xs text-muted-foreground">
                  Quando ligado, as legendas viram parte da imagem (sem
                  precisar de player com suporte a subtitles).
                </p>
              </div>
              <Switch
                id="export-burn"
                checked={settings.burnCaptions}
                onCheckedChange={(v) =>
                  setSettings((s) => ({ ...s, burnCaptions: v }))
                }
              />
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <Label className="text-sm font-medium">Sobreposições</Label>
              <div className="flex items-center justify-between">
                <div className="grid gap-0.5">
                  <Label htmlFor="export-logo">Incluir Logo</Label>
                  <p className="text-xs text-muted-foreground">Adiciona a logo no canto superior direito.</p>
                </div>
                <Switch
                  id="export-logo"
                  checked={settings.includeLogo}
                  onCheckedChange={(v) => setSettings((s) => ({ ...s, includeLogo: v }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="grid gap-0.5">
                  <Label htmlFor="export-footer">Incluir Rodapé</Label>
                  <p className="text-xs text-muted-foreground">Adiciona o rodapé na parte inferior.</p>
                </div>
                <Switch
                  id="export-footer"
                  checked={settings.includeFooter}
                  onCheckedChange={(v) => setSettings((s) => ({ ...s, includeFooter: v }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="grid gap-0.5">
                  <Label htmlFor="export-ending">Incluir Vinheta Final</Label>
                  <p className="text-xs text-muted-foreground">Adiciona o vídeo de encerramento ao final.</p>
                </div>
                <Switch
                  id="export-ending"
                  checked={settings.includeEnding}
                  onCheckedChange={(v) => setSettings((s) => ({ ...s, includeEnding: v }))}
                />
              </div>
            </div>

            {strategyInfo && (
              <StrategyHint
                strategy={strategyInfo.strategy}
                reason={
                  // Sem fallback pra nuvem, o motivo de bloqueio TEM de
                  // aparecer: e a unica forma de o usuario saber o que reduzir
                  // (duracao, resolucao, numero de faixas) para conseguir
                  // renderizar. Antes isso ficava escondido porque o projeto
                  // simplesmente ia pro servidor.
                  !strategyInfo.browser.supported
                    ? strategyInfo.browser.reason ?? null
                    : !strategyInfo.eligibility.eligible
                      ? strategyInfo.eligibility.exceedsLimits[0] ?? null
                      : null
                }
                durationSec={strategyInfo.eligibility.totalDurationSec}
              />
            )}

            {/* Destino do vídeo — aplica tanto pra render local quanto cloud. */}
            <div className="grid gap-2 rounded-md border p-3">
              <Label className="text-sm font-medium">Destino do vídeo final</Label>

              {originRecorte && (
                <button
                  type="button"
                  onClick={() => setSaveMode('replace')}
                  className={
                    'flex items-start gap-2 rounded-md border p-2.5 text-left text-xs transition-colors ' +
                    (saveMode === 'replace'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-accent')
                  }
                >
                  <EditorIcons.Refresh className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="flex-1">
                    <div className="font-semibold">Substituir vídeo original</div>
                    <div className="text-[10px] text-muted-foreground">
                      Atualiza{' '}
                      <span className="font-mono">{originRecorte.name ?? originRecorte.videoId}</span>{' '}
                      em Recortes (arquivo antigo é apagado).
                    </div>
                  </div>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setSaveMode('new-copy');
                  if (!destinationFolderId && originRecorte) {
                    setDestinationFolderId(originRecorte.folderId);
                  }
                }}
                className={
                  'flex items-start gap-2 rounded-md border p-2.5 text-left text-xs transition-colors ' +
                  (saveMode === 'new-copy'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent')
                }
              >
                <EditorIcons.Plus className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="font-semibold">Salvar nova cópia em pasta</div>
                  <div className="text-[10px] text-muted-foreground">
                    Cria um novo vídeo na pasta escolhida. Original (se houver) fica intacto.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSaveMode('download')}
                className={
                  'flex items-start gap-2 rounded-md border p-2.5 text-left text-xs transition-colors ' +
                  (saveMode === 'download'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent')
                }
              >
                <EditorIcons.Export className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="font-semibold">Apenas baixar</div>
                  <div className="text-[10px] text-muted-foreground">
                    Não salva em Recortes; gera arquivo pra download direto.
                  </div>
                </div>
              </button>

              {saveMode === 'new-copy' && (
                <div className="grid gap-1.5 pt-1">
                  <Label htmlFor="export-folder" className="text-xs">Pasta de destino</Label>
                  <Select
                    value={destinationFolderId || '__none__'}
                    onValueChange={(v) => setDestinationFolderId(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger id="export-folder" className="h-8 text-xs">
                      <SelectValue placeholder="Selecionar pasta..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— selecionar —</SelectItem>
                      {(folders ?? []).map((f) => (
                        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        )}

        {isRendering && (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <EditorIcons.Spinner className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm">
                  {clientRender.isRendering
                    ? 'Renderizando no seu navegador...'
                    : remoteJob?.status === 'rendering'
                      ? 'Renderizando no servidor...'
                      : 'Iniciando render...'}
                </span>
              </div>
              {remoteJob?.tier && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {remoteJob.tier}
                </Badge>
              )}
            </div>
            <Progress value={progressValue} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{progressValue}%</span>
              {!clientRender.isRendering && (
                <span className="text-right">
                  Pode fechar — você será notificado quando terminar.
                </span>
              )}
            </div>
          </div>
        )}

        {isComplete && (clientBlobUrl || remoteJob?.outputUrl) && (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-center gap-2 text-emerald-600">
              <EditorIcons.Success className="h-5 w-5" />
              <span className="text-sm font-medium">
                Render concluído com sucesso!
              </span>
            </div>
            {remoteJob?.savedVideoId && (
              <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                <EditorIcons.Video className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {saveMode === 'replace'
                    ? `Vídeo original substituído em Recortes.`
                    : `Salvo em Recortes (nova cópia).`}
                </span>
              </div>
            )}
            {/* Preview inline do resultado — antes só havia Baixar/Abrir, sem player. */}
            {!previewError && (
              <video
                src={clientBlobUrl ?? remoteJob?.outputUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                className="max-h-[50vh] w-full rounded-md border bg-black"
                onError={() => setPreviewError(true)}
              />
            )}
            {previewError && (
              <p className="text-xs text-muted-foreground">
                Não foi possível reproduzir o preview aqui. Use “Baixar” ou “Abrir” abaixo.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild className="flex-1">
                <a
                  href={clientBlobUrl ?? remoteJob?.outputUrl ?? '#'}
                  download={clientBlobUrl ? downloadFileName : undefined}
                >
                  <EditorIcons.Export className="mr-2 h-4 w-4" />
                  Baixar
                </a>
              </Button>
              <Button asChild variant="outline" className="flex-1">
                <a
                  href={clientBlobUrl ?? remoteJob?.outputUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir
                </a>
              </Button>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <EditorIcons.Error className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Falha no render</div>
              <div className="text-xs opacity-90">
                {errorMessage ?? 'Erro desconhecido.'}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {!isRendering && !isComplete && (
            <>
              <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
                Cancelar
              </Button>
              <Button
                onClick={() => void handleExport()}
                disabled={isSubmitting || !project}
              >
                {isSubmitting ? (
                  <EditorIcons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <EditorIcons.Export className="mr-2 h-4 w-4" />
                )}
                Exportar
              </Button>
            </>
          )}
          {isRendering && !clientRender.isRendering && (
            <Button variant="outline" onClick={handleClose}>
              Fechar (continuar em segundo plano)
            </Button>
          )}
          {isRendering && clientRender.isRendering && (
            <Button
              variant="outline"
              onClick={() => clientRender.cancel()}
            >
              Cancelar
            </Button>
          )}
          {(isComplete || isError) && !isRendering && (
            <Button onClick={handleClose}>Fechar</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Componente: hint de estratégia (badge + descrição)
// ============================================================================

function StrategyHint(props: {
  strategy: RenderStrategy;
  reason: string | null;
  durationSec: number;
}) {
  const { strategy, reason, durationSec } = props;

  if (strategy === 'client') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
        <Badge variant="outline" className="border-emerald-500 text-emerald-700">
          Render local
        </Badge>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">
            O vídeo será renderizado no seu navegador — mais rápido e sem
            consumir cota da nuvem.
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Duração: {formatDuration(durationSec)} · Estimativa:{' '}
            {estimateClientTime(durationSec)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
      <Badge variant="outline" className="border-sky-500 text-sky-700">
        Render na nuvem
      </Badge>
      <div className="flex-1">
        <div className="text-xs text-muted-foreground">
          {reason ? `Motivo: ${reason}.` : 'Render no servidor.'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Duração: {formatDuration(durationSec)} · Estimativa:{' '}
          {estimateCloudTime(durationSec)}
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function estimateClientTime(durationSec: number): string {
  // Heurística simples: ~1x da duração em ultrafast.
  const sec = Math.max(15, Math.round(durationSec));
  if (sec < 60) return `~${sec}s`;
  return `~${Math.round(sec / 60)}min`;
}

function estimateCloudTime(durationSec: number): string {
  // Cloud sobe + render + faz upload — overhead fixo + ~0.5x da duração.
  const sec = 60 + Math.round(durationSec * 0.5);
  if (sec < 60) return `~${sec}s`;
  return `~${Math.round(sec / 60)}min`;
}
