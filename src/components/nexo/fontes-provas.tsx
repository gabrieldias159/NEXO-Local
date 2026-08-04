'use client';

/**
 * NEXO — "Fontes & Provas". Por alerta, lista a procedência de cada evidência:
 * link clicável para a prova documental (deep-link da fonte) + badge do tipo de
 * documento + preview inline de PDF quando embedável (paifileserver, DOM proxy).
 *
 * Dois usos:
 *  - <FontesProvas provas={[...]} /> — bloco consolidado (lista de cards).
 *  - <ProvaEvidencia prova={p} /> — versão COMPACTA, embutida sob cada evidência
 *    do alerta (a prova documental clicável JUNTO do indício, não num bloco solto).
 */
import { useState } from 'react';
import {
  Boxes,
  ExternalLink,
  Eye,
  FileJson,
  FileText,
  Globe,
  ShieldCheck,
} from 'lucide-react';
import type { Procedencia } from '@/lib/nexo/detectores/tipos';

const BADGE: Record<Procedencia['tipoDoc'], { txt: string; cls: string }> = {
  pdf: { txt: 'Documento oficial', cls: 'text-emerald-300 bg-emerald-500/10' },
  pagina: { txt: 'Página oficial', cls: 'text-sky-300 bg-sky-500/10' },
  'api-json': { txt: 'API verificável', cls: 'text-violet-300 bg-violet-500/10' },
  modulo: { txt: 'Módulo/consulta', cls: 'text-slate-300 bg-slate-500/10' },
};

/** Ícone por natureza do documento (lucide ^0.475, já usados no repo). */
const ICON_TIPO: Record<
  Procedencia['tipoDoc'],
  React.ComponentType<{ className?: string }>
> = {
  pdf: FileText,
  pagina: Globe,
  'api-json': FileJson,
  modulo: Boxes,
};

/** Só ofertamos preview embutido para PDF de fato embedável (same-origin / CORS). */
function podeEmbed(p: Procedencia): boolean {
  return p.tipoDoc === 'pdf' && p.podePreview && !!p.url;
}

/** Link da prova: ícone do tipo + rótulo; sufixo "abre fora" só p/ link externo. */
function LinkProva({ p }: { p: Procedencia }) {
  const interno = p.url.startsWith('/');
  const Icone = ICON_TIPO[p.tipoDoc];
  return (
    <a
      href={p.url}
      target={interno ? '_self' : '_blank'}
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/5"
    >
      <Icone className="h-3 w-3 shrink-0 text-amber-400/80" />
      <span className="break-all">{p.label}</span>
      {!interno && (
        <ExternalLink className="h-2.5 w-2.5 shrink-0 text-slate-500" aria-hidden />
      )}
    </a>
  );
}

/** Botão + iframe lazy de preview, só quando o doc é PDF embedável. */
function PreviewPdf({ p }: { p: Procedencia }) {
  const [aberto, setAberto] = useState(false);
  if (!podeEmbed(p)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/5"
      >
        <Eye className="h-3 w-3" /> {aberto ? 'Ocultar' : 'Pré-visualizar'}
      </button>
      {aberto && (
        <iframe
          src={p.url}
          loading="lazy"
          title={p.label}
          referrerPolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts allow-popups"
          className="mt-3 h-[60vh] w-full basis-full rounded-md border border-white/10 bg-white"
        />
      )}
    </>
  );
}

function ProvaCard({ p }: { p: Procedencia }) {
  const conf = BADGE[p.tipoDoc];

  return (
    <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
          {p.fonte}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${conf.cls}`}>{conf.txt}</span>
        {p.refColecao && (
          <span className="font-mono text-[10px] text-slate-400">
            {p.refColecao}
            {p.refId ? `/${p.refId}` : ''}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {p.url && <LinkProva p={p} />}
        <PreviewPdf p={p} />
      </div>
    </div>
  );
}

/**
 * Versão COMPACTA para embutir sob UMA evidência: badge de fonte + tipo, link
 * clicável da prova e (se PDF) preview inline. Sem moldura de card própria — herda
 * o card da evidência — e sem empty-state (a ausência de prova é tratada por quem
 * chama, que simplesmente não renderiza este componente).
 */
export function ProvaEvidencia({ prova }: { prova: Procedencia }) {
  const conf = BADGE[prova.tipoDoc];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/5 pt-2">
      <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
        {prova.fonte}
      </span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] ${conf.cls}`}>{conf.txt}</span>
      {prova.url && <LinkProva p={prova} />}
      <PreviewPdf p={prova} />
    </div>
  );
}

export function FontesProvas({ provas }: { provas: Procedencia[] }) {
  if (!provas || provas.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-400">
        <ShieldCheck className="h-3.5 w-3.5" /> Sem fonte documental associada a este
        indício ainda.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {provas.map((p, i) => (
        <ProvaCard key={`${p.fonte}-${i}`} p={p} />
      ))}
    </div>
  );
}
