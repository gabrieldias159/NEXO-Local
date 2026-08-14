'use client';

/**
 * Painel central do editor: stage + controles de transporte.
 *
 * Layout interno:
 *   ┌─────────────────────────────┐
 *   │       PreviewStage          │  ← flex-1 (ocupa espaço)
 *   ├─────────────────────────────┤
 *   │       PreviewControls       │  ← altura fixa
 *   └─────────────────────────────┘
 */

import { PreviewStage } from './PreviewStage';
import { PreviewControls } from './PreviewControls';
import { MediaDiagnosticPanel } from './MediaDiagnosticPanel';
import { cn } from '@/lib/utils';

export function PreviewPanel() {
  return (
    <section
      className={cn(
        'flex h-full min-h-0 flex-col',
        'bg-background',
      )}
    >
      <div className="min-h-0 flex-1 relative">
        <PreviewStage />
        {/* Botao flutuante de diagnostico de midia (canto superior direito) */}
        <div className="absolute top-2 right-2 z-30">
          <MediaDiagnosticPanel />
        </div>
      </div>
      <PreviewControls />
    </section>
  );
}
