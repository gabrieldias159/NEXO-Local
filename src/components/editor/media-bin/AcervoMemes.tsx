'use client';

/**
 * ACERVO DE MEMES/EFEITOS em vídeo no MediaBin (recurso 14).
 *
 * Espelha a pasta `memes_video/` do acervo (os VM* já baixados) e o catálogo
 * online curado (`catalogo_online.json` + FONTES.md): Mixkit, Pexels,
 * Archive.org, Videezy, Pixabay, Coverr, Tenor e GIPHY. Busca por nome, fonte
 * e uso; download UNITÁRIO — o item escolhido é resolvido (página → arquivo)
 * e baixado só na hora.
 *
 * Regras editoriais visíveis na interface:
 *  - chip de RISCO com o motivo no tooltip;
 *  - Tenor/GIPHY levam o rótulo "uso orgânico, não impulsionar";
 *  - entradas que são BUSCA (precisam de chave) não têm botão de baixar —
 *    abrem a busca no navegador.
 */

import * as React from 'react';

import { useEditorStore } from '@/lib/editor/store';
import {
  ACERVO_DRAG_MIME,
  trazerDoAcervo,
  urlPreviewAcervo,
  type PedidoAcervo,
} from '@/lib/editor/acervo/cliente';
import type { ItemMeme, RespostaAcervo } from '@/lib/editor/acervo/tipos';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { EditorIcons } from '../shared/EditorIcons';
import { ChipRisco } from './ChipRisco';

export function AcervoMemes() {
  const projectId = useEditorStore((s) => s.project?.id ?? null);
  const addAsset = useEditorStore((s) => s.addAsset);
  const { toast } = useToast();

  const [open, setOpen] = React.useState(false);
  const [itens, setItens] = React.useState<ItemMeme[] | null>(null);
  const [erro, setErro] = React.useState<string | null>(null);
  const [busca, setBusca] = React.useState('');
  const [soDisco, setSoDisco] = React.useState(false);
  const [baixando, setBaixando] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || itens !== null) return;
    let cancelado = false;
    void (async () => {
      try {
        const res = await fetch('/api/editor/acervo?tipo=memes');
        const json = (await res.json()) as RespostaAcervo;
        if (cancelado) return;
        if (!json.ok) throw new Error(json.erro ?? 'falha ao ler o acervo');
        setItens(json.memes ?? []);
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

  const filtrados = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (itens ?? []).filter((m) => {
      if (soDisco && m.origem !== 'disco') return false;
      if (!q) return true;
      const alvo = `${m.nome} ${m.fonte} ${m.uso ?? ''}`.toLowerCase();
      return alvo.includes(q);
    });
  }, [itens, busca, soDisco]);

  const pedidoDe = (m: ItemMeme): PedidoAcervo => ({
    tipo: 'meme',
    nome: m.nome,
    arquivoLocal: m.arquivoLocal,
    url: m.url,
  });

  const trazer = async (m: ItemMeme) => {
    if (!projectId) return;
    setBaixando(m.id);
    try {
      const asset = await trazerDoAcervo(projectId, pedidoDe(m));
      addAsset(asset);
      toast({
        title: `"${asset.name}" entrou no projeto`,
        description: m.usoOrganico
          ? 'Conteúdo de terceiros: uso orgânico, NÃO impulsionar.'
          : m.licenca ?? undefined,
      });
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Não deu para trazer o efeito',
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
        title="Memes e efeitos em vídeo: os VM* já baixados e as fontes online catalogadas. Baixa só o que você escolher."
      >
        <EditorIcons.Video className="h-3.5 w-3.5" />
        Memes e efeitos
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
              placeholder="Buscar por efeito, fonte ou uso…"
              className="h-6 w-full rounded border border-border bg-background px-1.5 text-[10px] outline-none focus:border-[var(--editor-accent)]"
            />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setSoDisco((v) => !v)}
                title="Só os memes próprios já baixados (VM*) — uso imediato."
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[9px]',
                  soDisco
                    ? 'border-[var(--editor-accent)] bg-[var(--editor-accent)] text-white'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                já baixados
              </button>
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
            {filtrados.map((m) => (
              <div
                key={m.id}
                draggable={!!projectId && !m.somenteBusca}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    ACERVO_DRAG_MIME,
                    JSON.stringify(pedidoDe(m)),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="flex items-start gap-1.5 rounded px-1 py-1 hover:bg-muted"
                title={m.uso ? `Uso: ${m.uso}` : m.fonte}
              >
                {m.arquivoLocal ? (
                  <PreviewMeme caminho={m.arquivoLocal} />
                ) : (
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                    <EditorIcons.Link className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] text-foreground">{m.nome}</p>
                  <p className="truncate text-[9px] text-muted-foreground">
                    {m.fonte}
                    {m.uso ? ` · ${m.uso}` : ''}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <ChipRisco risco={m.risco} motivo={m.riscoDetalhe} />
                    {m.origem === 'disco' && (
                      <span className="rounded bg-muted px-1 text-[8px] uppercase text-muted-foreground">
                        no acervo
                      </span>
                    )}
                    {m.usoOrganico && (
                      <span
                        className="rounded border border-amber-500/60 px-1 text-[8px] uppercase tracking-wide text-amber-400"
                        title="Conteúdo de terceiros via API oficial: pode ser usado em post orgânico, NUNCA em conteúdo impulsionado."
                      >
                        uso orgânico, não impulsionar
                      </span>
                    )}
                  </div>
                </div>
                {m.somenteBusca ? (
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-border hover:text-foreground"
                    title="Essa fonte precisa de chave: abre a busca no navegador para escolher o GIF."
                  >
                    abrir busca
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => void trazer(m)}
                    disabled={!projectId || baixando === m.id}
                    className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-50"
                    title="Baixa só este efeito para o projeto"
                  >
                    {baixando === m.id ? '…' : '+ trazer'}
                  </button>
                )}
              </div>
            ))}
            {itens !== null && filtrados.length === 0 && !erro && (
              <p className="px-1 py-2 text-[10px] text-muted-foreground">
                Nenhum efeito com esse filtro.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Miniatura ANIMADA (recurso 16): parada por padrão, roda muda enquanto o
 * ponteiro está em cima. Sem `preload`, para abrir o painel não puxar 60
 * vídeos de uma vez.
 */
function PreviewMeme({ caminho }: { caminho: string }) {
  const ref = React.useRef<HTMLVideoElement | null>(null);
  return (
    <video
      ref={ref}
      src={urlPreviewAcervo(caminho)}
      muted
      loop
      playsInline
      preload="none"
      onMouseEnter={() => void ref.current?.play().catch(() => {})}
      onMouseLeave={() => {
        ref.current?.pause();
        if (ref.current) ref.current.currentTime = 0;
      }}
      className="mt-0.5 h-8 w-8 shrink-0 rounded bg-black object-cover"
      title="Passe o mouse para ver rodando"
    />
  );
}
