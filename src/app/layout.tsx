import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { FirebaseClientProvider } from '@/firebase/client-provider';
import { ThemeProvider } from '@/components/theme-provider';

// Layout raiz enxuto do NEXO-Local — extraído do shell multi-app do
// oficioexpress. Sem next/font/google (evita dependência de rede no build:
// o objetivo aqui é rodar 100% local/offline); o Tailwind já cai para a pilha
// de fontes do sistema quando 'Inter'/'Poppins' não estão instaladas.
export const metadata: Metadata = {
  title: 'NEXO — Sala de Situação',
  description:
    'Núcleo de Enfrentamento e Inteligência Pública — fiscalização municipal, 100% local.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="font-body antialiased" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <FirebaseClientProvider>
            <Suspense fallback={null}>{children}</Suspense>
            <Toaster />
          </FirebaseClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
