/**
 * Página raiz do Suite Editor de Vídeos.
 *
 * Comportamento atual: redireciona para `/projects` (lista de projetos
 * do usuário). Quem quer abrir um projeto específico passa por
 * `/apps/suite-editor-videos/[projectId]`.
 */

import { redirect } from 'next/navigation';

export default function SuiteEditorVideosPage() {
  redirect('/apps/suite-editor-videos/projects');
}
