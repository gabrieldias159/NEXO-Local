'use client';

/**
 * Biblioteca do GABINETE no MediaBin (recurso 9 do fluxo do gabinete).
 *
 * Aba fixa com o acervo aprovado que mora em `biblioteca/` no Storage:
 *   biblioteca/identidade/  → logo, rodapé, vinheta
 *   biblioteca/sons/        → sons aprovados (XP error, moedas... CC0)
 *   biblioteca/memes/       → memes próprios VM*
 *   biblioteca/cards/       → palavras/cards gerados
 *
 * Cada item entra no projeto com UM clique — vira um `MediaAsset` normal
 * (`source: 'firebase'` apontando direto para o arquivo da biblioteca, sem
 * copiar bytes). A escrita na pasta é só por seed/admin (ver storage.rules).
 */

import * as React from 'react';
import { listAll, ref as storageRef, getDownloadURL } from 'firebase/storage';
import type { StorageReference } from 'firebase/storage';
import { useStorage } from '@/firebase';
import { useEditorStore } from '@/lib/editor/store';
import {
  assetDaBiblioteca,
  tipoPeloNome,
  BIBLIOTECA_DRAG_MIME,
  type ItemBiblioteca,
} from '@/lib/editor/acervo/biblioteca';
import type { MediaAsset } from '@/lib/editor/types';
import { useToast } from '@/hooks/use-toast';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

type LibItem = ItemBiblioteca;

export function GabineteLibrary() {
  const storage = useStorage();
  const addAsset = useEditorStore((s) => s.addAsset);
  const { toast } = useToast();

  const [open, setOpen] = React.useState(false);

  // O assistente "Novo vídeo do gabinete" abre o editor com `?biblioteca=1`
  // e a biblioteca já vem aberta. Lido do `location` (e não de
  // `useSearchParams`) para não forçar Suspense no build estático.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('biblioteca') === '1') {
      setOpen(true);
    }
  }, []);
  const [items, setItems] = React.useState<LibItem[] | null>(null);
  const [erro, setErro] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState<string | null>(null);
  const [tocando, setTocando] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  /** Pré-escuta de um som da biblioteca (recurso 16). */
  const ouvir = async (item: LibItem) => {
    if (!storage) return;
    const el = audioRef.current;
    if (!el) return;
    if (tocando === item.fullPath) {
      el.pause();
      setTocando(null);
      return;
    }
    try {
      el.src = await getDownloadURL(storageRef(storage, item.fullPath));
      el.volume = 0.8;
      await el.play();
      setTocando(item.fullPath);
    } catch {
      toast({ title: 'Não deu para tocar esse arquivo aqui' });
    }
  };

  const carregar = React.useCallback(async () => {
    if (!storage) return;
    setErro(null);
    try {
      const raiz = await listAll(storageRef(storage, 'biblioteca'));
      const subRefs: StorageReference[] = [...raiz.prefixes];
      const encontrados: LibItem[] = raiz.items.map((i) => ({
        fullPath: i.fullPath,
        name: i.name,
        categoria: 'geral',
        type: tipoPeloNome(i.name),
      }));
      for (const sub of subRefs) {
        const lista = await listAll(sub);
        for (const i of lista.items) {
          encontrados.push({
            fullPath: i.fullPath,
            name: i.name,
            categoria: sub.name,
            type: tipoPeloNome(i.name),
          });
        }
      }
      encontrados.sort((a, b) =>
        `${a.categoria}/${a.name}`.localeCompare(`${b.categoria}/${b.name}`),
      );
      setItems(encontrados);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, [storage]);

  React.useEffect(() => {
    if (open && items === null) void carregar();
  }, [open, items, carregar]);

  const importar = async (item: LibItem) => {
    if (!storage) return;
    setImporting(item.fullPath);
    try {
      const asset: MediaAsset = await assetDaBiblioteca(storage, item);
      addAsset(asset);
      toast({ title: `"${item.name}" adicionada ao projeto` });
    } catch (e) {
      toast({
        title: 'Falha ao importar da biblioteca',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="rounded-[var(--editor-radius-md)] border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium',
          'text-muted-foreground hover:text-foreground',
        )}
        title="Acervo aprovado do gabinete: identidade, sons, memes VM* e cards"
      >
        <EditorIcons.Layers className="h-3.5 w-3.5" />
        Biblioteca do gabinete
        <span className="ml-auto text-[10px]">
          {open ? '▾' : '▸'}
          {items ? ` ${items.length}` : ''}
        </span>
      </button>

      <audio ref={audioRef} onEnded={() => setTocando(null)} className="hidden" />

      {open && (
        <div className="max-h-52 overflow-y-auto border-t border-border px-1 py-1">
          {items === null && (
            <p className="px-1 py-2 text-[10px] text-muted-foreground">
              Carregando…
            </p>
          )}
          {erro && (
            <p className="px-1 py-2 text-[10px] text-red-400">
              Não deu para listar a biblioteca: {erro}
            </p>
          )}
          {items?.length === 0 && !erro && (
            <p className="px-1 py-2 text-[10px] text-muted-foreground">
              Biblioteca vazia — os arquivos moram em `biblioteca/` no Storage
              (identidade/, sons/, memes/, cards/).
            </p>
          )}
          {(items ?? []).map((item) => {
            const Icon =
              item.type === 'audio'
                ? EditorIcons.Audio
                : item.type === 'image'
                  ? EditorIcons.Image
                  : EditorIcons.Video;
            return (
              <div
                key={item.fullPath}
                draggable
                onDragStart={(e) => {
                  // Arrastar direto pra timeline (recurso 16): a track importa
                  // o item no drop e já encaixa o clip no ponto solto.
                  e.dataTransfer.setData(
                    BIBLIOTECA_DRAG_MIME,
                    JSON.stringify(item),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted"
                title={
                  item.type === 'audio'
                    ? 'Arraste para uma track de áudio, ou clique no ▶ para ouvir'
                    : 'Arraste direto para a timeline'
                }
              >
                {item.type === 'audio' ? (
                  <button
                    type="button"
                    onClick={() => ouvir(item)}
                    className="shrink-0 rounded border border-border px-1 text-[9px] text-muted-foreground hover:bg-border hover:text-foreground"
                    title="Ouvir antes de usar"
                  >
                    {tocando === item.fullPath ? '■' : '▶'}
                  </button>
                ) : (
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] text-foreground">
                    {item.name}
                  </p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    {item.categoria}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void importar(item)}
                  disabled={importing === item.fullPath}
                  className={cn(
                    'shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px]',
                    'text-muted-foreground hover:bg-border hover:text-foreground',
                    'disabled:opacity-50',
                  )}
                  title="Adicionar ao projeto (sem copiar o arquivo)"
                >
                  {importing === item.fullPath ? '…' : '+ usar'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
