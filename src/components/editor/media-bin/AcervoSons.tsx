'use client';

/**
 * ACERVO DE SONS do gabinete no MediaBin (recurso 13).
 *
 * Mostra o catálogo inteiro — os sons já baixados no acervo e os 79
 * catalogados do myinstants — com busca por nome/tag/momento, pré-escuta por
 * streaming e o botão "trazer": baixa SÓ o som escolhido para a pasta do
 * projeto no Storage. Nunca download em massa (regra do acervo).
 *
 * Cada item mostra o RISCO editorial e o motivo, para a decisão ser tomada
 * antes de o som entrar no vídeo.
 */

import * as React from 'react';

import { useEditorStore } from '@/lib/editor/store';
import {
  ACERVO_DRAG_MIME,
  trazerDoAcervo,
  urlPreviewAcervo,
  type PedidoAcervo,
} from '@/lib/editor/acervo/cliente';
import type { ItemSom, RespostaAcervo } from '@/lib/editor/acervo/tipos';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { EditorIcons } from '../shared/EditorIcons';
import { ChipRisco } from './ChipRisco';

export function AcervoSons() {
  const projectId = useEditorStore((s) => s.project?.id ?? null);
  const addAsset = useEditorStore((s) => s.addAsset);
  const { toast } = useToast();

  const [open, setOpen] = React.useState(false);
  const [itens, setItens] = React.useState<ItemSom[] | null>(null);
  const [erro, setErro] = React.useState<string | null>(null);
  const [busca, setBusca] = React.useState('');
  const [soDisco, setSoDisco] = React.useState(false);
  const [soBaixoRisco, setSoBaixoRisco] = React.useState(false);
  const [tocando, setTocando] = React.useState<string | null>(null);
  const [baixando, setBaixando] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    if (!open || itens !== null) return;
    let cancelado = false;
    void (async () => {
      try {
        const res = await fetch('/api/editor/acervo?tipo=sons');
        const json = (await res.json()) as RespostaAcervo;
        if (cancelado) return;
        if (!json.ok) throw new Error(json.erro ?? 'falha ao ler o acervo');
        setItens(json.sons ?? []);
      } catch (e) {
        if (!cancelado) {
          setErro(e instanceof Error ? e.message : String(e));
          setItens([]);
        }
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [open, itens]);

  // Para a pré-escuta ao fechar o painel.
  React.useEffect(() => {
    if (open) return;
    audioRef.current?.pause();
    setTocando(null);
  }, [open]);

  const filtrados = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (itens ?? []).filter((s) => {
      if (soDisco && s.origem !== 'disco') return false;
      if (soBaixoRisco && s.risco !== 'baixo') return false;
      if (!q) return true;
      const alvo = `${s.nome} ${s.tags.join(' ')} ${s.momento ?? ''}`.toLowerCase();
      return alvo.includes(q);
    });
  }, [itens, busca, soDisco, soBaixoRisco]);

  const pedidoDe = (s: ItemSom): PedidoAcervo => ({
    tipo: 'som',
    nome: s.nome,
    arquivoLocal: s.arquivoLocal,
    urlPagina: s.urlPagina,
    url: s.urlMp3,
  });

  const ouvir = (s: ItemSom) => {
    const src = s.arquivoLocal
      ? urlPreviewAcervo(s.arquivoLocal)
      : (s.urlMp3 ?? '');
    if (!src) {
      toast({ title: 'Esse som só tem a página, sem preview direto' });
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (tocando === s.id) {
      el.pause();
      setTocando(null);
      return;
    }
    el.src = src;
    el.volume = 0.8;
    void el.play().then(
      () => setTocando(s.id),
      () =>
        toast({
          title: 'Não deu para tocar aqui',
          description: 'A fonte pode ter bloqueado a pré-escuta. Traga pro projeto e ouça na timeline.',
        }),
    );
  };

  const trazer = async (s: ItemSom) => {
    if (!projectId) return;
    setBaixando(s.id);
    try {
      const asset = await trazerDoAcervo(projectId, pedidoDe(s));
      addAsset(asset);
      toast({
        title: `"${asset.name}" entrou no projeto`,
        description:
          s.origem === 'disco'
            ? 'Copiado do acervo local.'
            : 'Baixado do myinstants só agora — nada mais foi baixado.',
      });
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Não deu para trazer o som',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBaixando(null);
    }
  };

  return (
    <div className="rounded-[var(--editor-radius-md)] border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
        title="Catálogo de sons do gabinete: busca por momento e tag, ouve antes e baixa só o que você escolher."
      >
        <EditorIcons.Audio className="h-3.5 w-3.5" />
        Sons do acervo
        <span className="ml-auto text-[10px]">
          {open ? '▾' : '▸'}
          {itens ? ` ${itens.length}` : ''}
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="space-y-1 px-2 py-1.5">
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por som, tag ou momento…"
              className="h-6 w-full rounded border border-border bg-background px-1.5 text-[10px] outline-none focus:border-[var(--editor-accent)]"
            />
            <div className="flex gap-1">
              <FiltroChip
                ativo={soDisco}
                onClick={() => setSoDisco((v) => !v)}
                title="Só os sons que já estão baixados no acervo (uso imediato)."
              >
                já baixados
              </FiltroChip>
              <FiltroChip
                ativo={soBaixoRisco}
                onClick={() => setSoBaixoRisco((v) => !v)}
                title="Esconde os de risco médio/alto (voz de meme conhecido, por exemplo)."
              >
                risco baixo
              </FiltroChip>
              <span className="ml-auto self-center text-[9px] text-muted-foreground">
                {filtrados.length} de {itens?.length ?? 0}
              </span>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto px-1 pb-1">
            {itens === null && (
              <p className="px-1 py-2 text-[10px] text-muted-foreground">
                Lendo o catálogo…
              </p>
            )}
            {erro && (
              <p className="px-1 py-2 text-[10px] text-red-400">
                Não deu para ler o acervo: {erro}
              </p>
            )}
            {filtrados.map((s) => (
              <div
                key={s.id}
                draggable={!!projectId}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    ACERVO_DRAG_MIME,
                    JSON.stringify(pedidoDe(s)),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="flex items-start gap-1.5 rounded px-1 py-1 hover:bg-muted"
                title={
                  s.momento
                    ? `Momento: ${s.momento}`
                    : 'Som do acervo — arraste para uma track de áudio'
                }
              >
                <button
                  type="button"
                  onClick={() => ouvir(s)}
                  className="mt-0.5 shrink-0 rounded border border-border px-1 text-[9px] text-muted-foreground hover:bg-border hover:text-foreground"
                  title="Ouvir antes de trazer"
                >
                  {tocando === s.id ? '■' : '▶'}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] text-foreground">{s.nome}</p>
                  {s.momento && (
                    <p className="truncate text-[9px] text-muted-foreground">
                      {s.momento}
                    </p>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <ChipRisco risco={s.risco} motivo={s.motivoRisco} />
                    {s.origem === 'disco' && (
                      <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                        no acervo
                      </span>
                    )}
                    {s.tags.slice(0, 2).map((t) => (
                      <span
                        key={t}
                        className="text-[8px] uppercase tracking-wide text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void trazer(s)}
                  disabled={!projectId || baixando === s.id}
                  className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-50"
                  title="Baixa só este som para o projeto"
                >
                  {baixando === s.id ? '…' : '+ trazer'}
                </button>
              </div>
            ))}
            {itens !== null && filtrados.length === 0 && !erro && (
              <p className="px-1 py-2 text-[10px] text-muted-foreground">
                Nenhum som com esse filtro.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Player único da pré-escuta. */}
      <audio
        ref={audioRef}
        onEnded={() => setTocando(null)}
        className="hidden"
      />
    </div>
  );
}

function FiltroChip({
  ativo,
  onClick,
  title,
  children,
}: {
  ativo: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[9px]',
        ativo
          ? 'border-[var(--editor-accent)] bg-[var(--editor-accent)] text-white'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}
