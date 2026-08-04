import type { Metadata } from 'next';
import { NexoShell } from '@/components/nexo/nexo-shell';
import { NexoQueryProvider } from '@/components/nexo/query-provider';

export const metadata: Metadata = {
  title: 'NEXO — Sala de Situação',
  description:
    'Núcleo de Enfrentamento e Inteligência Pública — fiscalização da Prefeitura de Marília.',
};

export default function NexoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NexoQueryProvider>
      <NexoShell>{children}</NexoShell>
    </NexoQueryProvider>
  );
}
