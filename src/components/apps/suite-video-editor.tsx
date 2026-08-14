/**
 * Re-export de compatibilidade.
 *
 * O Suite Editor de Vídeos foi refatorado em componentes modulares sob
 * `src/components/editor/*`. Este arquivo é mantido apenas como ponte
 * para imports antigos (`@/components/apps/suite-video-editor`) e pode
 * ser removido após uma rodada de auditoria de imports.
 *
 * Componente real: `src/components/editor/SuiteVideoEditor.tsx`
 */

export { SuiteVideoEditor } from '@/components/editor/SuiteVideoEditor';
