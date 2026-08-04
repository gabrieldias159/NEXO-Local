'use client';

/**
 * /nexo/servidores-camara — Relação de servidores (ATIVOS e ex/DESLIGADOS) da
 * CÂMARA Municipal de Marília. Separado da folha da PREFEITURA (SMARAPD) — cada
 * um com seu órgão de origem. Fonte: planilha pública da Câmara (via
 * /api/nexo/servidores-camara). Filtro por situação, cargo, lotação e busca.
 */
import { useEffect, useMemo, useState } from 'react';
import { Users, Search, Building2 } from 'lucide-react';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type { ServidoresCamaraResponse, ServidorCamara } from '@/app/api/nexo/servidores-camara/route';
import { NexoPage, NexoPageHeader } from '@/components/nexo/ui/nexo-page';
import { NexoCard } from '@/components/nexo/ui/nexo-card';
import { NexoCarregando, NexoErro, NexoVazio } from '@/components/nexo/ui/nexo-estado';
import { NexoTableWrap, NexoThead } from '@/components/nexo/ui/nexo-table';
import { NexoKpiGrid, NexoKpi } from '@/components/nexo/ui/nexo-kpi';
import { INPUT_NEXO } from '@/components/nexo/ui/nexo-tokens';
import { cn } from '@/lib/utils';

type Situacao = 'todos' | 'ativo' | 'desligado';
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function ServidoresCamaraPage() {
  const [data, setData] = useState<ServidoresCamaraResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregar, setRecarregar] = useState(0);
  const [q, setQ] = useState('');
  const [situacao, setSituacao] = useState<Situacao>('ativo');
  const [cargo, setCargo] = useState('');

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setErro(null);
    (async () => {
      try {
        const r = await nexoFetch('/api/nexo/servidores-camara');
        const j = (await r.json()) as ServidoresCamaraResponse;
        if (!vivo) return;
        if (!r.ok || j.erro) throw new Error(j.erro ?? `HTTP ${r.status}`);
        setData(j);
      } catch (e) {
        if (vivo) setErro(e instanceof Error ? e.message : 'erro desconhecido');
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [recarregar]);

  const cargos = useMemo(
    () => [...new Set((data?.servidores ?? []).map((s) => s.cargo).filter(Boolean) as string[])].sort(),
    [data],
  );

  const lista = useMemo(() => {
    const termo = norm(q.trim());
    return (data?.servidores ?? []).filter((s) => {
      if (situacao !== 'todos' && s.situacao !== situacao) return false;
      if (cargo && s.cargo !== cargo) return false;
      if (termo && !norm(`${s.nome} ${s.cargo ?? ''} ${s.lotacao ?? ''}`).includes(termo)) return false;
      return true;
    });
  }, [data, q, situacao, cargo]);

  return (
    <NexoPage largura="padrao">
      <NexoPageHeader
        icone={Users}
        titulo="Servidores da Câmara"
        subtitulo={
          <>
            Relação de servidores <b>ativos e desligados</b> da Câmara Municipal de Marília — separada
            da folha da Prefeitura. {data?.atualizadoEm ? `Atualizado em ${data.atualizadoEm}.` : ''}
          </>
        }
      >
        <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">
          <Building2 className="h-3.5 w-3.5" /> Câmara Municipal
        </span>
      </NexoPageHeader>

      {loading ? (
        <NexoCarregando variante="tabela" linhas={10} />
      ) : erro ? (
        <NexoErro detalhe={erro} aoTentarNovamente={() => setRecarregar((n) => n + 1)} />
      ) : !data ? null : (
        <>
          <NexoKpiGrid>
            <NexoKpi rotulo="Total" valor={data.total} icone={Users} />
            <NexoKpi rotulo="Ativos" valor={data.ativos} cor="text-emerald-300" />
            <NexoKpi rotulo="Desligados" valor={data.desligados} cor="text-slate-300" />
            <NexoKpi rotulo="Cargos" valor={cargos.length} />
          </NexoKpiGrid>

          {/* filtros */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por nome, cargo ou lotação…"
                className={cn(INPUT_NEXO, 'w-full py-2 pl-9 pr-3 text-sm')}
              />
            </div>
            <div className="flex rounded-md border border-white/10 bg-nexo-chrome p-0.5 text-xs">
              {(
                [
                  ['ativo', 'Ativos'],
                  ['desligado', 'Desligados'],
                  ['todos', 'Todos'],
                ] as [Situacao, string][]
              ).map(([s, label]) => (
                <button
                  key={s}
                  onClick={() => setSituacao(s)}
                  className={cn(
                    'rounded px-2.5 py-1.5 font-medium transition-colors',
                    situacao === s ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={cargo}
              onChange={(e) => setCargo(e.target.value)}
              className={cn(INPUT_NEXO, 'px-2 py-2 text-sm')}
            >
              <option value="">Todos os cargos</option>
              {cargos.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-400">{lista.length} servidor(es)</span>
          </div>

          {lista.length === 0 ? (
            <NexoVazio titulo="Nenhum servidor para este filtro." />
          ) : (
            <NexoTableWrap>
              <NexoThead>
                <tr>
                  <th className="px-3 py-2 text-left">Servidor</th>
                  <th className="px-3 py-2 text-left">Cargo</th>
                  <th className="px-3 py-2 text-left">Lotação</th>
                  <th className="px-3 py-2 text-left">Admissão</th>
                  <th className="px-3 py-2 text-left">Situação</th>
                </tr>
              </NexoThead>
              <tbody className="divide-y divide-white/5">
                {lista.slice(0, 500).map((s: ServidorCamara, i) => (
                  <tr key={`${s.nome}-${i}`} className="bg-nexo-inset">
                    <td className="px-3 py-2 text-slate-200">{s.nome}</td>
                    <td className="px-3 py-2 text-slate-400">{s.cargo ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{s.lotacao ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-400">{s.admissao ?? '—'}</td>
                    <td className="px-3 py-2">
                      {s.situacao === 'ativo' ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">ativo</span>
                      ) : (
                        <span className="rounded bg-slate-500/20 px-1.5 py-0.5 text-[11px] text-slate-300">
                          desligado{s.demissao ? ` · ${s.demissao}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </NexoTableWrap>
          )}

          <p className="text-[11px] leading-relaxed text-slate-500">
            Fonte: {data.fonte}. Dados públicos de RH da Câmara (Lei de Acesso à Informação).
            A folha de pagamento da PREFEITURA fica em <a href="/nexo/folha" className="text-sky-400 hover:text-sky-300">Folha &amp; Terceirizados</a> — bases mantidas separadas por órgão.
          </p>
        </>
      )}
    </NexoPage>
  );
}
