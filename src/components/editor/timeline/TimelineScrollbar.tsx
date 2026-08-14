'use client';

/**
 * Scrollbar horizontal customizada e SEMPRE VISÍVEL para a timeline do
 * Suite Editor (substitui a scrollbar nativa do OS, que era muito sutil).
 *
 * Mostra:
 *  - Track de fundo representando 100% da duração da timeline (com tracks).
 *  - "Viewport thumb" arrastável que indica a região visível atual.
 *  - Playhead miniatura sobreposto (linha amarela) pra orientar o usuário.
 *
 * Eventos:
 *  - Click no track → centraliza o viewport ali.
 *  - Drag no thumb → scroll horizontal sincronizado com o `scrollRef`.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface TimelineScrollbarProps {
  /** Ref do container scrollável da timeline. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Largura total do conteúdo (px). */
  contentWidth: number;
  /** Largura fixa do header de tracks (px) — usada pra calcular offset. */
  trackHeaderWidth: number;
  /** Tempo atual do playhead em segundos. */
  playhead: number;
  /** Zoom px/segundo. */
  zoom: number;
  /** Duração total da timeline (segundos) — usada pra calcular novo zoom. */
  durationSec: number;
  /** Callback pra alterar o zoom (clamped pelo store em 5..1000). */
  onZoomChange: (newZoomPxPerSec: number) => void;
  className?: string;
}

export function TimelineScrollbar({
  scrollRef,
  contentWidth,
  trackHeaderWidth,
  playhead,
  zoom,
  durationSec,
  onZoomChange,
  className,
}: TimelineScrollbarProps) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = React.useState(0);
  const [viewportWidth, setViewportWidth] = React.useState(0);
  const dragRef = React.useRef<{
    startClientX: number;
    startScrollLeft: number;
    pointerId: number;
  } | null>(null);

  // Sincroniza com o scroll real do container.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setScrollLeft(el.scrollLeft);
      setViewportWidth(el.clientWidth);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  // Visible portion do conteúdo (descontando o header fixo à esquerda).
  const visibleContentWidth = Math.max(0, viewportWidth - trackHeaderWidth);
  const totalWidth = trackHeaderWidth + contentWidth;
  const maxScrollLeft = Math.max(0, totalWidth - viewportWidth);

  // Mapeia scrollLeft real → posição/largura proporcional do thumb dentro da
  // barra (que ocupa 100% do contentWidth, não inclui o header).
  const thumbPct =
    contentWidth > 0
      ? Math.min(100, (visibleContentWidth / contentWidth) * 100)
      : 100;
  const thumbLeftPct =
    contentWidth > 0
      ? Math.max(0, Math.min(100 - thumbPct, (scrollLeft / contentWidth) * 100))
      : 0;
  const playheadPct =
    contentWidth > 0
      ? Math.max(0, Math.min(100, ((playhead * zoom) / contentWidth) * 100))
      : 0;

  const scrollByDelta = (deltaPx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(maxScrollLeft, el.scrollLeft + deltaPx));
    el.scrollLeft = next;
  };

  const scrollToPct = (pct: number) => {
    const el = scrollRef.current;
    if (!el || contentWidth <= 0) return;
    // Centraliza o viewport no ponto clicado.
    const targetContentLeft = (pct / 100) * contentWidth - visibleContentWidth / 2;
    el.scrollLeft = Math.max(0, Math.min(maxScrollLeft, targetContentLeft));
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    scrollToPct(pct);
  };

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startScrollLeft: el.scrollLeft,
      pointerId: e.pointerId,
    };
  };

  const handleThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || contentWidth <= 0) return;
    const deltaX = e.clientX - dragRef.current.startClientX;
    // Converte deltaX da barra (em px) pra deltaScroll no conteúdo.
    // barra largura representa contentWidth; então 1px barra = contentWidth/rect.width px scroll.
    const scrollDelta = (deltaX / rect.width) * contentWidth;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, dragRef.current.startScrollLeft + scrollDelta),
    );
  };

  const handleThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  // ====== Zoom handles (bolinhas nas pontas do thumb, estilo Adobe Rush) ======
  // Arrastar a bolinha esquerda ou direita PRA DENTRO do thumb → afina o thumb
  // → contentWidth maior → zoom MAIS. Arrastar PRA FORA → engorda o thumb →
  // zoom MENOS.
  //
  // Mecânica: o usuário não muda o "edge" do viewport (scroll position fica),
  // ele só altera o tamanho do thumb proporcionalmente. Convertemos a nova
  // largura do thumb (em %) pra um novo `zoom` que mantenha aquela proporção.
  const zoomDragRef = React.useRef<{
    pointerId: number;
    side: 'left' | 'right';
    startClientX: number;
    startZoom: number;
    startScrollLeft: number;
    anchorTime: number; // tempo no qual a "ancora" do drag fica fixa
  } | null>(null);

  const startZoomDrag = (e: React.PointerEvent<HTMLDivElement>, side: 'left' | 'right') => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el || durationSec <= 0) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    // Ancora: ponto OPOSTO ao handle, em segundos — mantém esse ponto fixo no
    // viewport enquanto o usuário zooma.
    const visibleContentLeft = el.scrollLeft;
    const visibleContentRight = visibleContentLeft + (el.clientWidth - trackHeaderWidth);
    const anchorPx = side === 'left' ? visibleContentRight : visibleContentLeft;
    const anchorTime = anchorPx / zoom;
    zoomDragRef.current = {
      pointerId: e.pointerId,
      side,
      startClientX: e.clientX,
      startZoom: zoom,
      startScrollLeft: el.scrollLeft,
      anchorTime,
    };
  };

  const moveZoomDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = zoomDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const rect = trackRef.current?.getBoundingClientRect();
    const el = scrollRef.current;
    if (!rect || !el || durationSec <= 0) return;

    const deltaX = e.clientX - drag.startClientX;
    // Direção: pra DIREITA (positivo) reduz a largura do thumb (mais zoom) se
    // for handle esquerdo. Pra handle direito é o inverso.
    const widthDelta = drag.side === 'left' ? -deltaX : deltaX;
    // Nova largura percentual do thumb (estimada).
    const visibleContentWidth = el.clientWidth - trackHeaderWidth;
    const currentThumbPx = (visibleContentWidth / (durationSec * drag.startZoom)) * rect.width;
    const newThumbPx = Math.max(20, currentThumbPx + widthDelta);
    // newThumbPx / rect.width = visibleContentWidth / (durationSec * newZoom)
    // → newZoom = visibleContentWidth * rect.width / (durationSec * newThumbPx)
    const newZoom = (visibleContentWidth * rect.width) / (durationSec * newThumbPx);
    const clamped = Math.max(5, Math.min(1000, newZoom));
    onZoomChange(clamped);

    // Mantém a âncora visível na mesma posição na viewport.
    // anchorPx_no_novo_zoom = anchorTime * clamped
    // se side='left': anchorPx era o RIGHT edge → manter
    //   newScrollLeft = anchorPx - visibleContentWidth
    // se side='right': anchorPx era o LEFT edge → manter
    //   newScrollLeft = anchorPx
    const newAnchorPx = drag.anchorTime * clamped;
    const newScrollLeft = drag.side === 'left'
      ? Math.max(0, newAnchorPx - visibleContentWidth)
      : Math.max(0, newAnchorPx);
    el.scrollLeft = newScrollLeft;
  };

  const endZoomDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoomDragRef.current?.pointerId === e.pointerId) {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      zoomDragRef.current = null;
    }
  };

  // Não renderiza se não há overflow horizontal (timeline cabe inteira).
  const hasOverflow = maxScrollLeft > 1;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center border-t border-border bg-card/80 backdrop-blur-sm',
        className,
      )}
      style={{ height: 18 }}
    >
      {/* Espaço alinhado com o header de tracks à esquerda. */}
      <div
        className="shrink-0 border-r border-border h-full flex items-center justify-center gap-1 px-1.5"
        style={{ width: trackHeaderWidth }}
      >
        <button
          type="button"
          onClick={() => scrollByDelta(-200)}
          disabled={!hasOverflow || scrollLeft <= 0}
          className="h-3.5 w-3.5 rounded-sm flex items-center justify-center text-muted-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-[10px] leading-none"
          aria-label="Rolar pra esquerda"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => scrollByDelta(200)}
          disabled={!hasOverflow || scrollLeft >= maxScrollLeft - 1}
          className="h-3.5 w-3.5 rounded-sm flex items-center justify-center text-muted-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-[10px] leading-none"
          aria-label="Rolar pra direita"
        >
          ›
        </button>
      </div>

      {/* Track (área da barra) */}
      <div
        ref={trackRef}
        className="relative h-full flex-1 cursor-pointer overflow-hidden bg-muted/60"
        onClick={handleTrackClick}
      >
        {hasOverflow ? (
          <>
            {/* Viewport thumb */}
            <div
              className="absolute top-1 bottom-1 rounded-full bg-primary/70 hover:bg-primary cursor-grab active:cursor-grabbing transition-colors"
              style={{
                left: `${thumbLeftPct}%`,
                width: `${Math.max(thumbPct, 3)}%`,
                // Sem touch-action:none o iOS trata o arraste como rolagem da
                // página e o thumb não se move no iPad.
                touchAction: 'none',
              }}
              onPointerDown={handleThumbPointerDown}
              onPointerMove={handleThumbPointerMove}
              onPointerUp={handleThumbPointerUp}
              onPointerCancel={handleThumbPointerUp}
              onClick={(e) => e.stopPropagation()}
              role="scrollbar"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={maxScrollLeft}
              aria-valuenow={scrollLeft}
            >
              {/* Bolinha esquerda — zoom handle (Adobe Rush style) */}
              <div
                onPointerDown={(e) => startZoomDrag(e, 'left')}
                onPointerMove={moveZoomDrag}
                onPointerUp={endZoomDrag}
                onPointerCancel={endZoomDrag}
                onClick={(e) => e.stopPropagation()}
                title="Arraste pra dentro/fora pra dar zoom na timeline"
                style={{ touchAction: 'none' }}
                className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-white border border-primary shadow cursor-ew-resize hover:scale-125 transition-transform"
              />
              {/* Bolinha direita — zoom handle */}
              <div
                onPointerDown={(e) => startZoomDrag(e, 'right')}
                onPointerMove={moveZoomDrag}
                onPointerUp={endZoomDrag}
                onPointerCancel={endZoomDrag}
                onClick={(e) => e.stopPropagation()}
                title="Arraste pra dentro/fora pra dar zoom na timeline"
                style={{ touchAction: 'none' }}
                className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-white border border-primary shadow cursor-ew-resize hover:scale-125 transition-transform"
              />
            </div>
            {/* Playhead miniatura sobreposto */}
            <div
              className="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none"
              style={{ left: `${playheadPct}%` }}
            />
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/60">
            Timeline cabe na tela
          </div>
        )}
      </div>
    </div>
  );
}
