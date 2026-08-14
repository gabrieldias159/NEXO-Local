'use client';

/**
 * Estado vazio do Inspector — quando nada está selecionado.
 *
 * Mostrado dentro do painel direito sempre que `selectedClipIds` e
 * `selectedCueIds` estão vazios. Conteúdo: ícone + dica de uso.
 */

import { EditorIcons } from '../shared/EditorIcons';

export function EmptyInspector() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"
      >
        <EditorIcons.Sliders className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">
        Nenhum item selecionado
      </p>
      <p className="text-xs text-muted-foreground">
        Selecione um clip para editar suas propriedades.
      </p>
    </div>
  );
}
