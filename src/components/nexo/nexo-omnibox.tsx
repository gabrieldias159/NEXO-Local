'use client';

/**
 * Omnibox global do NEXO (Ctrl/⌘+K) — a entrada única de uma sala de situação.
 * Três seções:
 *  - "Ir para": rotas do menu (filtro local instantâneo);
 *  - "Entidades": empresas/fornecedores por nome ou CNPJ (GET /api/nexo/busca?
 *    tipo=empresas, debounce 300ms) → dossiê;
 *  - fallback: "Buscar '<q>' no Raio-X" → /nexo/busca.
 * Trigger no header do shell; atalho global registrado no NexoShell.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, ArrowRight, Radar } from 'lucide-react';
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from '@/components/ui/command';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { ROTAS_NAV } from './nexo-nav';
import { soDigitos } from '@/lib/nexo/entidades';

interface EntidadeResultado {
  documento: string;
  documentoRaw: string;
  nome: string;
}

export function NexoOmnibox({ aberto, aoFechar }: { aberto: boolean; aoFechar: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [entidades, setEntidades] = useState<EntidadeResultado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const reqId = useRef(0);

  const irPara = useCallback(
    (href: string) => {
      aoFechar();
      setQ('');
      router.push(href);
    },
    [aoFechar, router],
  );

  // Busca de entidades (debounce) — dispara só com ≥3 chars.
  useEffect(() => {
    const termo = q.trim();
    if (termo.length < 3) {
      setEntidades([]);
      return;
    }
    const id = ++reqId.current;
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const r = await nexoFetch(`/api/nexo/busca?tipo=empresas&q=${encodeURIComponent(termo)}`);
        const j = r.ok ? await r.json() : { resultados: [] };
        if (id === reqId.current) setEntidades((j.resultados ?? []).slice(0, 8));
      } catch {
        if (id === reqId.current) setEntidades([]);
      } finally {
        if (id === reqId.current) setBuscando(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const termo = q.trim();
  const termoLower = termo.toLowerCase();
  const rotasFiltradas = termo
    ? ROTAS_NAV.filter(
        (r) =>
          r.label.toLowerCase().includes(termoLower) ||
          r.aliases.some((a) => a.toLowerCase().includes(termoLower)),
      ).slice(0, 6)
    : ROTAS_NAV.slice(0, 6);

  return (
    <CommandDialog open={aberto} onOpenChange={(o) => (o ? undefined : aoFechar())}>
      <CommandInput
        placeholder="Buscar página, fornecedor, CNPJ…"
        value={q}
        onValueChange={setQ}
      />
      <CommandList>
        <CommandEmpty>{buscando ? 'Buscando…' : 'Nada encontrado.'}</CommandEmpty>

        <CommandGroup heading="Ir para">
          {rotasFiltradas.map((r) => (
            <CommandItem key={r.href} value={`rota ${r.label}`} onSelect={() => irPara(r.href)}>
              <Radar className="text-slate-400" />
              <span>{r.label}</span>
              <span className="ml-auto text-xs text-slate-500">{r.grupo}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {entidades.length > 0 && (
          <CommandGroup heading="Entidades">
            {entidades.map((e) => (
              <CommandItem
                key={e.documentoRaw}
                value={`ent ${e.nome} ${e.documentoRaw}`}
                onSelect={() => irPara(`/nexo/dossie/${soDigitos(e.documentoRaw)}`)}
              >
                <Building2 className="text-slate-400" />
                <span className="truncate">{e.nome}</span>
                <span className="ml-auto font-mono text-xs text-slate-500">{e.documento}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {termo.length >= 2 && (
          <CommandGroup heading="Busca completa">
            <CommandItem
              value={`raiox ${termo}`}
              onSelect={() => irPara(`/nexo/busca?q=${encodeURIComponent(termo)}`)}
            >
              <ArrowRight className="text-slate-400" />
              <span>
                Buscar “{termo}” no Raio-X
              </span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
