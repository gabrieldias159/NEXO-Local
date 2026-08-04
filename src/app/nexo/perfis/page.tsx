'use client';

/**
 * /nexo/perfis — BUSCA DE PERFIS (pessoa física ou jurídica).
 *
 * Entrada única para o perfilamento: digita um nome ou CNPJ/CPF e cai na ficha
 * que cruza TUDO que o NEXO sabe.
 *  - Pessoas (PF): índice dos datasets eleitorais (candidatos 2012–2024 +
 *    doadores) por nome → /nexo/pessoa/{personId} (a ficha resolve candidaturas,
 *    doações, sócio de empresa, folha, diárias, DOM, TCE ao vivo). Fallback de
 *    texto livre: abre a ficha por nome normalizado mesmo sem estar no índice.
 *  - Empresas (PJ): /api/nexo/busca?tipo=empresas (agregado de empenhos/
 *    contratos) → /nexo/fornecedores/{cnpj}.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { UserSearch, Building2, UserSquare2, ArrowRight, Loader2 } from 'lucide-react';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { NexoPage, NexoPageHeader } from '@/components/nexo/ui/nexo-page';
import { NexoCard } from '@/components/nexo/ui/nexo-card';
import { INPUT_NEXO } from '@/components/nexo/ui/nexo-tokens';
import { cn } from '@/lib/utils';

const ANOS = [2024, 2020, 2016, 2012];

function normNome(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

interface Pessoa {
  personId: string;
  nome: string;
  detalhe?: string;
}
interface Empresa {
  documento: string;
  documentoRaw: string;
  nome: string;
}

// índice de pessoas carregado uma vez (client) dos estáticos de eleições.
let indicePessoasCache: Pessoa[] | null = null;
async function carregarIndicePessoas(): Promise<Pessoa[]> {
  if (indicePessoasCache) return indicePessoasCache;
  const jsonOr = async (u: string, fb: unknown) => {
    try {
      const r = await fetch(u);
      return r.ok ? await r.json() : fb;
    } catch {
      return fb;
    }
  };
  const porId = new Map<string, Pessoa>();
  const cands = await Promise.all(ANOS.map((a) => jsonOr(`/eleicoes/candidatos_${a}.json`, [])));
  for (let i = 0; i < ANOS.length; i++) {
    for (const c of cands[i] as { personId?: string; nome?: string; urna?: string; partido?: string }[]) {
      if (!c.personId || porId.has(c.personId)) continue;
      porId.set(c.personId, {
        personId: c.personId,
        nome: c.nome ?? c.urna ?? c.personId.replace(/^n:/, ''),
        detalhe: `candidato ${ANOS[i]}${c.partido ? ` · ${c.partido}` : ''}`,
      });
    }
  }
  const doadores = await jsonOr('/eleicoes/doadores.json', { doadores: [] });
  for (const d of (doadores.doadores ?? []) as { personId?: string; nome?: string; tipo?: string }[]) {
    if (d.tipo !== 'fisica' || !d.personId || porId.has(d.personId)) continue;
    porId.set(d.personId, { personId: d.personId, nome: d.nome ?? d.personId.replace(/^n:/, ''), detalhe: 'doador de campanha' });
  }
  indicePessoasCache = [...porId.values()];
  return indicePessoasCache;
}

export default function PerfisPage() {
  const [q, setQ] = useState('');
  const [indice, setIndice] = useState<Pessoa[]>([]);
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    void carregarIndicePessoas().then(setIndice);
  }, []);

  // busca de empresas (debounce, ≥3 chars)
  useEffect(() => {
    const termo = q.trim();
    if (termo.length < 3) {
      setEmpresas([]);
      return;
    }
    let vivo = true;
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const r = await nexoFetch(`/api/nexo/busca?tipo=empresas&q=${encodeURIComponent(termo)}`);
        const j = r.ok ? await r.json() : { resultados: [] };
        if (vivo) setEmpresas((j.resultados ?? []).slice(0, 20));
      } catch {
        if (vivo) setEmpresas([]);
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 300);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [q]);

  const termo = q.trim();
  const alvo = normNome(termo);
  const pessoas = useMemo(() => {
    if (termo.length < 2) return [];
    return indice.filter((p) => normNome(p.nome).includes(alvo)).slice(0, 30);
  }, [indice, alvo, termo]);

  const soDigitos = termo.replace(/\D+/g, '');
  const pareceCpfCnpj = soDigitos.length >= 11;

  return (
    <NexoPage largura="padrao">
      <NexoPageHeader
        icone={UserSearch}
        titulo="Busca de perfis"
        subtitulo="Pessoa física ou jurídica — abre a ficha que cruza todos os vínculos e bases do NEXO."
      />

      <div className="relative">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nome da pessoa, razão social, CPF ou CNPJ…"
          className={cn(INPUT_NEXO, 'w-full py-2.5 pl-10 pr-3 text-sm')}
        />
        <UserSearch className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
        {buscando && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-slate-500 motion-reduce:animate-none" />}
      </div>

      {termo.length < 2 ? (
        <p className="text-sm text-slate-400">Digite ao menos 2 caracteres. Pessoas vêm dos dados eleitorais (2012–2024) e das bases cruzadas; empresas, do cadastro de fornecedores com empenho/contrato.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Pessoas (PF) */}
          <NexoCard className="p-4">
            <p className="flex items-center gap-2 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <UserSquare2 className="h-3.5 w-3.5" /> Pessoas ({pessoas.length})
            </p>
            {pessoas.length === 0 ? (
              <p className="text-xs text-slate-500">Nenhuma pessoa conhecida com esse nome nos datasets. Use o atalho abaixo para abrir a ficha mesmo assim.</p>
            ) : (
              <ul className="space-y-1">
                {pessoas.map((p) => (
                  <li key={p.personId}>
                    <Link
                      href={`/nexo/pessoa/${encodeURIComponent(p.personId)}`}
                      className="flex items-center justify-between rounded-md border border-white/10 bg-nexo-inset px-3 py-2 text-sm hover:border-amber-500/30"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-slate-200">{p.nome}</span>
                        {p.detalhe && <span className="block text-[11px] text-slate-500">{p.detalhe}</span>}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {termo.length >= 4 && !pareceCpfCnpj && (
              <Link
                href={`/nexo/pessoa/${encodeURIComponent('n:' + alvo)}`}
                className="mt-2 inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
              >
                abrir ficha de “{termo}” <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </NexoCard>

          {/* Empresas (PJ) */}
          <NexoCard className="p-4">
            <p className="flex items-center gap-2 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <Building2 className="h-3.5 w-3.5" /> Empresas ({empresas.length})
            </p>
            {empresas.length === 0 ? (
              <p className="text-xs text-slate-500">
                {buscando ? 'Buscando…' : 'Nenhuma empresa com empenho/contrato para esse termo.'}
              </p>
            ) : (
              <ul className="space-y-1">
                {empresas.map((e) => (
                  <li key={e.documentoRaw}>
                    <Link
                      href={`/nexo/fornecedores/${e.documentoRaw.replace(/\D+/g, '')}`}
                      className="flex items-center justify-between rounded-md border border-white/10 bg-nexo-inset px-3 py-2 text-sm hover:border-amber-500/30"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-slate-200">{e.nome}</span>
                        <span className="block font-mono text-[11px] text-slate-500">{e.documento}</span>
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </NexoCard>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        A ficha de pessoa cruza candidaturas, doações, sociedade em empresas,
        folha, diárias, atos no Diário Oficial e contas do TCE — por nome (fontes
        públicas mascaram CPF), com rótulo de risco de homônimo. A de empresa traz
        cadastro, sócios, sanções e o que recebeu da prefeitura.
      </p>
    </NexoPage>
  );
}
