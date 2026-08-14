'use client';

/**
 * Grid principal do editor (sem o header).
 *
 * Layout (large screens, ≥ 1024px):
 *
 *   ┌──────┬──────────────────────────┬────────────┐
 *   │      │       Preview            │            │
 *   │  MB  ├──────────────────────────┤ Inspector  │
 *   │      │       Timeline           │            │
 *   └──────┴──────────────────────────┴────────────┘
 *
 * - Em ≥1024px usa `ResizablePanelGroup` (react-resizable-panels) com handles
 *   draggable entre os painéis e persistência automática no localStorage
 *   (`autoSaveId`).
 * - Em <1024px os painéis laterais viram `Sheet` (drawers) acionados por
 *   botões no `EditorHeader` via `EditorLayoutContext`.
 */

import { ReactNode, useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useMediaQuery } from '@/hooks/use-media-query';
import { EditorLayoutProvider } from './layout-context';

interface EditorLayoutProps {
  mediaBin: ReactNode;
  preview: ReactNode;
  timeline: ReactNode;
  inspector: ReactNode;
  className?: string;
}

export function EditorLayout({
  mediaBin,
  preview,
  timeline,
  inspector,
  className,
}: EditorLayoutProps) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [mediaBinOpen, setMediaBinOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const toggleMediaBin = useCallback(
    () => setMediaBinOpen((prev) => !prev),
    [],
  );
  const toggleInspector = useCallback(
    () => setInspectorOpen((prev) => !prev),
    [],
  );

  const layoutCtx = useMemo(
    () => ({
      toggleMediaBin,
      toggleInspector,
      isMobileLayout: !isDesktop,
    }),
    [toggleMediaBin, toggleInspector, isDesktop],
  );

  // O painel central (Preview + Timeline) é compartilhado entre desktop e
  // mobile — em mobile ele ocupa 100% da largura.
  const centerVertical = (
    <ResizablePanelGroup
      direction="vertical"
      autoSaveId="editor-layout-v"
      className="h-full"
    >
      <ResizablePanel defaultSize={62} minSize={30} id="preview" order={1}>
        <div className="h-full min-h-0 min-w-0">{preview}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={38} minSize={20} id="timeline" order={2}>
        <div className="h-full min-h-0">{timeline}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );

  return (
    <EditorLayoutProvider value={layoutCtx}>
      <div className={cn('h-full min-h-0 w-full', className)}>
        {isDesktop ? (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="editor-layout-h"
            className="h-full"
          >
            <ResizablePanel
              defaultSize={20}
              minSize={15}
              maxSize={35}
              id="media-bin"
              order={1}
            >
              <div className="h-full min-h-0 min-w-0">{mediaBin}</div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={55} minSize={40} id="center" order={2}>
              {centerVertical}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={25}
              minSize={18}
              maxSize={40}
              id="inspector"
              order={3}
            >
              <div className="h-full min-h-0 min-w-0">{inspector}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <>
            <div className="h-full min-h-0 w-full">{centerVertical}</div>
            {/* Drawer MediaBin (esquerda) */}
            <Sheet open={mediaBinOpen} onOpenChange={setMediaBinOpen}>
              <SheetContent
                side="left"
                className="w-[80vw] max-w-[320px] p-0 sm:w-[320px]"
              >
                <div className="h-full min-h-0 min-w-0">{mediaBin}</div>
              </SheetContent>
            </Sheet>
            {/* Drawer Inspector (direita) */}
            <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
              <SheetContent
                side="right"
                className="w-[80vw] max-w-[360px] p-0 sm:w-[360px]"
              >
                <div className="h-full min-h-0 min-w-0">{inspector}</div>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>
    </EditorLayoutProvider>
  );
}
