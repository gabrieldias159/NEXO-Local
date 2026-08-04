import { redirect } from 'next/navigation';

// Este repo é focado só no NEXO — a raiz sempre entra direto na sala de
// situação. (No oficioexpress original, "/" era o dashboard multi-app.)
export default function RootPage() {
  redirect('/nexo');
}
