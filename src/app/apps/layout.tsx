/**
 * Layout do Estúdio de Vídeo.
 *
 * O editor inteiro (EditorLayout, painéis, timeline) é montado com `h-full`,
 * ou seja, `height: 100%` — o que só resolve se TODOS os ancestrais tiverem
 * altura definida. No oficioexpress essa cadeia vinha do shell multi-app; na
 * extração para o NEXO-Local ela ficou para trás, e o `globals.css` daqui não
 * define `html, body { height: 100% }`.
 *
 * Resultado do que faltava: o `h-full` colapsava para a altura do conteúdo e o
 * editor aparecia espremido no topo, com o resto da viewport preto.
 *
 * Este layout fecha a cadeia num ponto só — sem mexer no `globals.css`, que é
 * compartilhado com as páginas do NEXO (essas rolam normalmente e seriam
 * prejudicadas por um `height: 100%` global).
 */
export default function AppsLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[100dvh] flex-col overflow-hidden">{children}</div>;
}
