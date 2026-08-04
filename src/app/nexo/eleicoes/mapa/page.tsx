'use client';

/**
 * Mapa por bairro — Marília (aproximado).
 *
 * Coroplético SVG a partir do GeoJSON gerado por Voronoi das coordenadas dos
 * locais de votação do TSE (public/eleicoes/mapa_bairros.geojson), recortado no
 * contorno municipal do IBGE. É uma APROXIMAÇÃO: cada "bairro" é a área de
 * influência de onde a pessoa VOTA (local de votação), não o limite oficial.
 *
 * Modos:
 *  - Eleitorado: cor = eleitores por bairro (cadastro 2024).
 *  - Votação (vereador/prefeito, ano selecionável 2016/2020/2024):
 *      sem candidato  -> CAMPEÃO por bairro (cor do partido do mais votado);
 *      com candidato  -> intensidade pela % do candidato nos votos nominais
 *                        do bairro; com COMPARATIVO opcional vs a eleição
 *                        anterior em que a mesma pessoa concorreu (verde =
 *                        cresceu, vermelho = caiu, em pontos percentuais).
 *  - Clique em um bairro FIXA o painel lateral com o top-10 dele.
 * Dados: votos_bairro_{ano}.json (TSE votação por seção agregada por bairro).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Map as MapIcon, Users, Vote, X, Pin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Feature {
  properties: { bairro: string; locais?: number; eleitores?: number };
  geometry: { type: string; coordinates: number[][][][] | number[][][] };
}
interface CandBairro {
  nome: string;
  partido: string | null;
  sq: string | null;
  personId: string | null;
  eleito: boolean | null;
  total: number;
  votos: number[];
}
interface DadosCargo {
  cands: Record<string, CandBairro>;
  totalPorBairro: number[];
  especiais: Record<string, number[]>;
}
interface VotosBairro {
  bairros: string[];
  cargos: Record<'vereador' | 'prefeito', DadosCargo>;
}

const nfmt = new Intl.NumberFormat('pt-BR');
const W = 820;
const H = 640;
const PAD = 16;
const ANOS_VOT = [2024, 2020, 2016, 2012] as const;

// cores aproximadas por partido (fallback: hash -> hue)
const COR_PARTIDO: Record<string, string> = {
  PT: '#dc2626', PCdoB: '#b91c1c', PV: '#16a34a', PSOL: '#f59e0b', REDE: '#0d9488',
  PSB: '#eab308', PDT: '#f97316', MDB: '#22c55e', PSDB: '#3b82f6', CIDADANIA: '#ec4899',
  PP: '#60a5fa', PL: '#1d4ed8', REPUBLICANOS: '#2563eb', PSD: '#a3e635', UNIÃO: '#38bdf8',
  UNIAO: '#38bdf8', PODE: '#8b5cf6', PODEMOS: '#8b5cf6', NOVO: '#fb923c', PRTB: '#64748b',
  SOLIDARIEDADE: '#d97706', AVANTE: '#a855f7', PMB: '#f472b6', AGIR: '#94a3b8',
  MOBILIZA: '#84cc16', DC: '#7dd3fc', PRD: '#c084fc', PSC: '#34d399', PROS: '#fbbf24',
  PTB: '#111827', DEM: '#93c5fd', PSL: '#facc15', PATRIOTA: '#4ade80', PMN: '#fca5a5',
  PRB: '#2563eb', PR: '#1d4ed8', PSDC: '#7dd3fc', PTN: '#8b5cf6', PEN: '#4ade80',
  PHS: '#f472b6', PRP: '#fb7185', PTC: '#a78bfa', PPS: '#ec4899', SD: '#d97706',
  'PC do B': '#b91c1c',
};
function corPartido(p: string | null): string {
  if (!p) return '#475569';
  if (COR_PARTIDO[p]) return COR_PARTIDO[p];
  let h = 0;
  for (const ch of p) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 55%)`;
}

type Modo = 'eleitorado' | 'vereador' | 'prefeito';
type Visao = 'cidade' | 'municipio';

// distritos rurais ficam fora da visão "cidade" (área urbana ocupa o mapa todo)
const RE_DISTRITO = /DISTRITO|PADRE N[OÓ]BREGA/i;

// abreviações p/ rótulos dentro dos polígonos
function rotuloCurto(nome: string): string {
  return nome
    .replace(/\s*\(.*\)$/, '')
    .replace(/^NÚCLEO HABITACIONAL|^N\. H\.|^NÚCLEO HBITACIONAL/i, 'N.H.')
    .replace(/^CONJUNTO RESIDENCIAL|^C\. H\./i, 'C.R.')
    .replace(/^RESIDENCIAL/i, 'RES.')
    .replace(/^PROLONGAMENTO/i, 'PROL.')
    .replace(/^JARDIM/i, 'JD.')
    .replace(/^PARQUE/i, 'PQ.')
    .replace(/^DISTRITO DE/i, '')
    .trim();
}

export default function MapaPage() {
  const [feats, setFeats] = useState<Feature[]>([]);
  const [vbPorAno, setVbPorAno] = useState<Record<number, VotosBairro | null>>({});
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [pinado, setPinado] = useState<string | null>(null);
  const [modo, setModo] = useState<Modo>('vereador');
  const [visao, setVisao] = useState<Visao>('cidade');
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [anoVot, setAnoVot] = useState<number>(2024);
  const [candNr, setCandNr] = useState<string>(''); // '' = campeão por bairro
  const [partidoSel, setPartidoSel] = useState<string>(''); // força de partido (nominais+legenda)
  const [buscaCand, setBuscaCand] = useState('');
  const [comparar, setComparar] = useState(false);

  // deep-link: /nexo/eleicoes/mapa?cargo=vereador&cand=15000&ano=2024
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const cg = sp.get('cargo');
    if (cg === 'vereador' || cg === 'prefeito') setModo(cg);
    const a = Number(sp.get('ano'));
    if (ANOS_VOT.includes(a as (typeof ANOS_VOT)[number])) setAnoVot(a);
    const nr = sp.get('cand');
    if (nr) setCandNr(nr);
    const pt = sp.get('partido');
    if (pt) setPartidoSel(pt);
  }, []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const jsonOr = async (u: string) => {
          try {
            const r = await fetch(u);
            return r.ok ? await r.json() : null;
          } catch {
            return null;
          }
        };
        const [gj, v24, v20, v16, v12] = await Promise.all([
          fetch('/eleicoes/mapa_bairros.geojson').then((r) => r.json()),
          jsonOr('/eleicoes/votos_bairro_2024.json'),
          jsonOr('/eleicoes/votos_bairro_2020.json'),
          jsonOr('/eleicoes/votos_bairro_2016.json'),
          jsonOr('/eleicoes/votos_bairro_2012.json'),
        ]);
        if (!vivo) return;
        setFeats(gj.features || []);
        setVbPorAno({ 2024: v24, 2020: v20, 2016: v16, 2012: v12 });
      } catch {
        if (vivo) setFeats([]);
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  const anosDisponiveis = ANOS_VOT.filter((a) => vbPorAno[a]);
  const vb = vbPorAno[anoVot] ?? null;

  // projeção lon/lat -> viewBox (linear, y invertido), com correção de latitude
  // p/ não achatar leste-oeste, filtro por visão (cidade × município), suavização
  // Chaikin e centróide+área p/ rótulos
  const { paths, maxEleitores, totalEleitores, nForaDaVisao } = useMemo(() => {
    const inclui = (f: Feature) => visao === 'municipio' || !RE_DISTRITO.test(f.properties.bairro);
    const visiveis = feats.filter(inclui);
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    const polysOf = (f: Feature): number[][][] => {
      const g = f.geometry;
      if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).flatMap((p) => p);
      if (g.type === 'Polygon') return g.coordinates as number[][][];
      return [];
    };
    // fator de correção: 1° de longitude encolhe com cos(latitude)
    const kLon = Math.cos((-22.2 * Math.PI) / 180);
    for (const f of visiveis)
      for (const ring of polysOf(f))
        for (const [lon, lat] of ring) {
          const x = lon * kLon;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (lat < minY) minY = lat;
          if (lat > maxY) maxY = lat;
        }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    const offX = (W - spanX * scale) / 2;
    const offY = (H - spanY * scale) / 2;
    const proj = (lon: number, lat: number): [number, number] => [
      offX + (lon * kLon - minX) * scale,
      // inverte Y: latitude maior = mais ao norte = topo
      H - (offY + (lat - minY) * scale),
    ];
    let maxE = 0,
      totE = 0;
    for (const f of visiveis) {
      const e = f.properties.eleitores || 0;
      if (e > maxE) maxE = e;
      totE += e;
    }
    const paths = visiveis.map((f) => {
      let cx = 0,
        cy = 0,
        areaTotal = 0;
      const d = polysOf(f)
        .map((ring) => {
          let pts = ring.map(([lon, lat]) => proj(lon, lat));
          // remove ponto de fechamento duplicado antes de suavizar
          if (
            pts.length > 1 &&
            Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 0.01 &&
            Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 0.01
          )
            pts = pts.slice(0, -1);
          // centróide/área (shoelace) ANTES da suavização — no anel maior
          let a = 0,
            sx = 0,
            sy = 0;
          for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            const cross = x1 * y2 - x2 * y1;
            a += cross;
            sx += (x1 + x2) * cross;
            sy += (y1 + y2) * cross;
          }
          a /= 2;
          if (Math.abs(a) > Math.abs(areaTotal)) {
            areaTotal = a;
            cx = a !== 0 ? sx / (6 * a) : pts[0][0];
            cy = a !== 0 ? sy / (6 * a) : pts[0][1];
          }
          // Arestas RETAS (sem suavização): os bairros são células Voronoi que
          // COMPARTILHAM bordas — arredondar cada polígono sozinho (Chaikin)
          // quebrava o encaixe entre vizinhos e sujava as bordas internas,
          // sobretudo no modo cidade (células maiores). Retas se encaixam exato.
          return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
        })
        .join(' ');
      return {
        bairro: f.properties.bairro,
        eleitores: f.properties.eleitores || 0,
        locais: f.properties.locais || 0,
        d,
        cx,
        cy,
        area: Math.abs(areaTotal),
      };
    });
    return { paths, maxEleitores: maxE, totalEleitores: totE, nForaDaVisao: feats.length - visiveis.length };
  }, [feats, visao]);

  const cargoAtivo = modo === 'eleitorado' ? null : modo;
  const dadosCargo: DadosCargo | null = cargoAtivo && vb ? vb.cargos[cargoAtivo] : null;
  const idxBairro = useMemo(() => {
    const m = new Map<string, number>();
    vb?.bairros.forEach((b, i) => m.set(b, i));
    return m;
  }, [vb]);

  // lista de candidatos do cargo/ano ativos, p/ seletor (ordenada por votos)
  const candidatos = useMemo(() => {
    if (!dadosCargo) return [];
    const termo = buscaCand.trim().toLowerCase();
    return Object.entries(dadosCargo.cands)
      .map(([nr, c]) => ({ nr, ...c }))
      .filter((c) => !termo || `${c.nome} ${c.partido ?? ''} ${c.nr}`.toLowerCase().includes(termo))
      .sort((a, b) => b.total - a.total);
  }, [dadosCargo, buscaCand]);

  const candSel = candNr && dadosCargo ? dadosCargo.cands[candNr] ?? null : null;

  // agrega a força de um PARTIDO por bairro: nominais dos candidatos + legenda
  const agregaPartido = (d: DadosCargo, sigla: string, nB: number): { votos: number[]; total: number } | null => {
    const votos = new Array(nB).fill(0);
    let achou = false;
    let nrPartido: string | null = null;
    for (const [nr, c] of Object.entries(d.cands)) {
      if (c.partido !== sigla) continue;
      achou = true;
      if (!nrPartido && nr.length === 5) nrPartido = nr.slice(0, 2);
      c.votos.forEach((v, i) => (votos[i] += v));
    }
    if (!achou) return null;
    const leg = nrPartido ? d.especiais[`legenda_${nrPartido}`] : null;
    if (leg) leg.forEach((v, i) => (votos[i] += v));
    return { votos, total: votos.reduce((a, b) => a + b, 0) };
  };

  // partidos do cargo/ano, p/ o seletor (ordenados por votos)
  const partidos = useMemo(() => {
    if (!dadosCargo) return [] as [string, number][];
    const tot = new Map<string, number>();
    for (const c of Object.values(dadosCargo.cands))
      if (c.partido) tot.set(c.partido, (tot.get(c.partido) || 0) + c.total);
    return [...tot].sort((a, b) => b[1] - a[1]);
  }, [dadosCargo]);

  const partidoAgg = useMemo(
    () => (partidoSel && dadosCargo && vb ? agregaPartido(dadosCargo, partidoSel, vb.bairros.length) : null),
    [partidoSel, dadosCargo, vb], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // série ativa no mapa: candidato OU partido
  const serie = useMemo(() => {
    if (candSel)
      return { rotulo: `${candSel.nome}${candSel.partido ? ` (${candSel.partido})` : ''}`, votos: candSel.votos, total: candSel.total };
    if (partidoAgg) return { rotulo: `${partidoSel} (nominais + legenda)`, votos: partidoAgg.votos, total: partidoAgg.total };
    return null;
  }, [candSel, partidoAgg, partidoSel]);

  // eleição anterior comparável: mesma pessoa (personId) ou mesmo partido
  const comp = useMemo(() => {
    if (!cargoAtivo || !serie) return null;
    for (const a of ANOS_VOT) {
      if (a >= anoVot) continue;
      const vbAnt = vbPorAno[a];
      const d = vbAnt?.cargos[cargoAtivo];
      if (!vbAnt || !d) continue;
      if (candSel?.personId) {
        const c = Object.values(d.cands).find((x) => x.personId === candSel.personId);
        if (c) return { ano: a, votos: c.votos, total: c.total };
      } else if (partidoSel) {
        const agg = agregaPartido(d, partidoSel, vbAnt.bairros.length);
        if (agg) return { ano: a, votos: agg.votos, total: agg.total };
      }
    }
    return null;
  }, [cargoAtivo, serie, anoVot, vbPorAno, candSel, partidoSel]); // eslint-disable-line react-hooks/exhaustive-deps
  const anoComp = comp?.ano ?? null;

  // % da série por bairro no ano ativo
  const pctDe = (d: DadosCargo, c: CandBairro, i: number): number => {
    const tot = d.totalPorBairro[i] || 0;
    return tot > 0 ? (c.votos[i] / tot) * 100 : 0;
  };
  const deltas = useMemo(() => {
    if (!comparar || !serie || !comp || !vb || !cargoAtivo) return null;
    const totA = vb.cargos[cargoAtivo].totalPorBairro;
    const totB = vbPorAno[comp.ano]!.cargos[cargoAtivo].totalPorBairro;
    // os arquivos compartilham a mesma lista de bairros (referência 2024)
    return vb.bairros.map((_, i) => {
      const pa = (totA[i] || 0) > 0 ? (serie.votos[i] / totA[i]) * 100 : 0;
      const pb = (totB[i] || 0) > 0 ? (comp.votos[i] / totB[i]) * 100 : 0;
      return pa - pb;
    });
  }, [comparar, serie, comp, vb, cargoAtivo, vbPorAno]);
  const maxAbsDelta = useMemo(
    () => (deltas ? Math.max(0.001, ...deltas.map((d) => Math.abs(d))) : 0),
    [deltas],
  );

  // campeão por bairro (modo votação sem candidato)
  const campeoes = useMemo(() => {
    if (!dadosCargo || !vb) return new Map<string, { nome: string; partido: string | null; votos: number }>();
    const m = new Map<string, { nome: string; partido: string | null; votos: number }>();
    vb.bairros.forEach((b, i) => {
      let top: { nome: string; partido: string | null; votos: number } | null = null;
      for (const c of Object.values(dadosCargo.cands))
        if (!top || c.votos[i] > top.votos) top = { nome: c.nome, partido: c.partido, votos: c.votos[i] };
      if (top) m.set(b, top);
    });
    return m;
  }, [dadosCargo, vb]);

  // % máxima da série (p/ normalizar a escala)
  const maxPctSerie = useMemo(() => {
    if (!serie || !dadosCargo || !vb) return 0;
    let mx = 0;
    vb.bairros.forEach((_, i) => {
      const tot = dadosCargo.totalPorBairro[i] || 0;
      if (tot > 0) mx = Math.max(mx, (serie.votos[i] / tot) * 100);
    });
    return mx;
  }, [serie, dadosCargo, vb]);

  const fillDe = (bairro: string, destaque: boolean): string => {
    const alpha = destaque ? 1 : 0.85;
    if (modo === 'eleitorado' || !vb || !dadosCargo) {
      const p = paths.find((x) => x.bairro === bairro);
      const ratio = maxEleitores && p ? p.eleitores / maxEleitores : 0;
      return `hsl(38 92% ${18 + ratio * 42}% / ${alpha})`;
    }
    const i = idxBairro.get(bairro);
    if (i == null) return `hsl(220 10% 16% / ${alpha})`;
    if (deltas) {
      const d = deltas[i];
      const ratio = Math.abs(d) / maxAbsDelta;
      // diverge: verde cresceu, vermelho caiu
      return d >= 0
        ? `hsl(150 70% ${16 + ratio * 34}% / ${alpha})`
        : `hsl(0 75% ${16 + ratio * 34}% / ${alpha})`;
    }
    if (serie) {
      const tot = dadosCargo.totalPorBairro[i] || 0;
      const pctB = tot > 0 ? (serie.votos[i] / tot) * 100 : 0;
      const ratio = maxPctSerie > 0 ? pctB / maxPctSerie : 0;
      return `hsl(200 90% ${14 + ratio * 46}% / ${alpha})`;
    }
    const camp = campeoes.get(bairro);
    return camp ? corPartido(camp.partido) : `hsl(220 10% 16% / ${alpha})`;
  };

  // bairro em foco: pinado tem prioridade sobre hover
  const foco = pinado ?? hover;

  // top-N do bairro em foco (modo votação)
  const topDoBairro = useMemo(() => {
    if (!foco || !dadosCargo || !vb) return [];
    const i = idxBairro.get(foco);
    if (i == null) return [];
    const tot = dadosCargo.totalPorBairro[i] || 0;
    return Object.entries(dadosCargo.cands)
      .map(([nr, c]) => ({ nr, nome: c.nome, partido: c.partido, personId: c.personId, v: c.votos[i], pct: tot ? (c.votos[i] / tot) * 100 : 0 }))
      .sort((a, b) => b.v - a.v)
      .slice(0, pinado ? 10 : 5);
  }, [foco, pinado, dadosCargo, vb, idxBairro]);

  // top bairros da série (ou maiores variações, no comparativo)
  const topBairrosCand = useMemo(() => {
    if (!serie || !dadosCargo || !vb) return [];
    if (deltas) {
      const arr = vb.bairros.map((b, i) => ({ bairro: b, v: serie.votos[i], delta: deltas[i] }));
      const subiu = [...arr].sort((a, b) => b.delta - a.delta).slice(0, 4);
      const caiu = [...arr].sort((a, b) => a.delta - b.delta).slice(0, 4);
      return [...subiu, ...caiu];
    }
    return vb.bairros
      .map((b, i) => {
        const tot = dadosCargo.totalPorBairro[i] || 0;
        return { bairro: b, v: serie.votos[i], pct: tot > 0 ? (serie.votos[i] / tot) * 100 : 0, delta: null as number | null };
      })
      .sort((a, b) => b.v - a.v)
      .slice(0, 8);
  }, [serie, dadosCargo, vb, deltas]);

  // legenda de partidos no modo campeão
  const legendaCampeoes = useMemo(() => {
    if (serie || modo === 'eleitorado') return [];
    const cont = new Map<string, number>();
    for (const c of campeoes.values()) cont.set(c.partido ?? '?', (cont.get(c.partido ?? '?') || 0) + 1);
    return [...cont].sort((a, b) => b[1] - a[1]);
  }, [campeoes, serie, modo]);

  const focado = paths.find((p) => p.bairro === foco);
  const focoIdx = foco ? idxBairro.get(foco) : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <Link href="/nexo/eleicoes" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Eleições
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
          <MapIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Mapa por bairro — Marília</h1>
          <p className="text-xs text-slate-500">
            {paths.length} bairros{visao === 'cidade' && nForaDaVisao > 0 ? ` (+${nForaDaVisao} distritos fora da visão)` : ''} ·{' '}
            {nfmt.format(totalEleitores)} eleitores
            {modo !== 'eleitorado' && vb ? ` · votação ${anoVot} (1º turno)` : ''}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/10 bg-nexo-chrome p-0.5 text-xs">
            {(
              [
                ['cidade', 'Cidade'],
                ['municipio', 'Município'],
              ] as [Visao, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setVisao(v)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 font-medium transition-colors',
                  visao === v ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {modo !== 'eleitorado' && anosDisponiveis.length > 1 && (
            <div className="flex rounded-lg border border-white/10 bg-nexo-chrome p-0.5 text-xs">
              {anosDisponiveis.map((a) => (
                <button
                  key={a}
                  onClick={() => {
                    setAnoVot(a);
                    setCandNr('');
                    setPartidoSel('');
                    setComparar(false);
                  }}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 font-medium transition-colors',
                    anoVot === a ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          )}
          <div className="flex rounded-lg border border-white/10 bg-nexo-chrome p-0.5 text-xs">
            {(
              [
                ['vereador', 'Vereador'],
                ['prefeito', 'Prefeito'],
                ['eleitorado', 'Eleitorado'],
              ] as [Modo, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => {
                  setModo(m);
                  setCandNr('');
                  setPartidoSel('');
                  setBuscaCand('');
                  setComparar(false);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1.5 font-medium transition-colors',
                  modo === m ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* seletor de candidato (modo votação) */}
      {modo !== 'eleitorado' && vb && (
        <div className="flex flex-wrap items-center gap-2">
          {serie ? (
            <>
              <span className="inline-flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200">
                <Vote className="h-3.5 w-3.5" />
                {serie.rotulo} · {nfmt.format(serie.total)} votos em {anoVot}
                <button
                  onClick={() => {
                    setCandNr('');
                    setPartidoSel('');
                    setComparar(false);
                  }}
                  className="text-sky-400 hover:text-sky-200"
                  aria-label="limpar"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
              {comp && (
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={comparar}
                    onChange={(e) => setComparar(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  evolução vs {comp.ano} ({nfmt.format(comp.total)} votos)
                </label>
              )}
            </>
          ) : (
            <>
              <input
                value={buscaCand}
                onChange={(e) => setBuscaCand(e.target.value)}
                placeholder="Buscar candidato p/ ver a força por bairro…"
                className="min-w-[240px] flex-1 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-amber-500/40 focus:outline-none sm:max-w-xs"
              />
              {buscaCand.trim() && (
                <div className="flex flex-wrap gap-1.5">
                  {candidatos.slice(0, 6).map((c) => (
                    <button
                      key={c.nr}
                      onClick={() => {
                        setCandNr(c.nr);
                        setBuscaCand('');
                      }}
                      className="rounded-md border border-white/10 bg-nexo-chrome px-2 py-1 text-xs text-slate-300 hover:border-sky-500/40 hover:text-sky-300"
                    >
                      {c.nome} {c.partido ? `· ${c.partido}` : ''} ({nfmt.format(c.total)})
                    </button>
                  ))}
                </div>
              )}
              <select
                value={partidoSel}
                onChange={(e) => setPartidoSel(e.target.value)}
                className="rounded-md border border-white/10 bg-nexo-chrome px-2 py-1.5 text-xs text-slate-300"
              >
                <option value="">ou partido…</option>
                {partidos.map(([p, t]) => (
                  <option key={p} value={p}>
                    {p} ({nfmt.format(t)})
                  </option>
                ))}
              </select>
              {!buscaCand.trim() && (
                <span className="text-[11px] text-slate-500">
                  Sem seleção: cor = partido do <b>mais votado</b> em cada bairro. Clique num bairro pra fixar o ranking dele.
                </span>
              )}
            </>
          )}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-[640px] w-full" />
      ) : paths.length === 0 ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Mapa indisponível.
          </CardContent>
        </Card>
      ) : modo !== 'eleitorado' && !vb ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Votação de {anoVot} ainda não disponível por bairro.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div
            className="relative overflow-hidden rounded-lg border border-white/10 bg-nexo-inset"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onMouseLeave={() => setMouse(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img">
              {paths.map((p) => {
                const destaque = foco === p.bairro;
                return (
                  <path
                    key={p.bairro}
                    d={p.d}
                    fillRule="evenodd"
                    fill={fillDe(p.bairro, destaque)}
                    stroke={pinado === p.bairro ? '#38bdf8' : destaque ? '#fbbf24' : '#0a0b0f'}
                    strokeWidth={destaque ? 1.6 : 0.7}
                    strokeLinejoin="round"
                    onMouseEnter={() => setHover(p.bairro)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setPinado((atual) => (atual === p.bairro ? null : p.bairro))}
                    className="cursor-pointer transition-[fill] duration-150"
                  />
                );
              })}
              {/* rótulos nos polígonos com área suficiente */}
              {paths
                .filter((p) => p.area > (visao === 'cidade' ? 900 : 1600))
                .map((p) => (
                  <text
                    key={`rot-${p.bairro}`}
                    x={p.cx}
                    y={p.cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none select-none"
                    style={{
                      fontSize: Math.max(8, Math.min(12, Math.sqrt(p.area) / 8)),
                      fill: foco === p.bairro ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)',
                      paintOrder: 'stroke',
                      stroke: 'rgba(0,0,0,0.55)',
                      strokeWidth: 2,
                    }}
                  >
                    {rotuloCurto(p.bairro)}
                  </text>
                ))}
            </svg>

            {/* tooltip flutuante */}
            {mouse && hover && !pinado && (
              <div
                className="pointer-events-none absolute z-10 rounded-md border border-white/10 bg-black/85 px-2.5 py-1.5 text-xs shadow-lg"
                style={{
                  left: Math.min(mouse.x + 14, 620),
                  top: Math.max(mouse.y - 10, 4),
                }}
              >
                <p className="font-semibold text-slate-100">{hover}</p>
                {modo === 'eleitorado' ? (
                  <p className="text-slate-400">
                    {nfmt.format(paths.find((p) => p.bairro === hover)?.eleitores || 0)} eleitores
                  </p>
                ) : serie && idxBairro.get(hover) != null && dadosCargo ? (
                  <p className="text-sky-300">
                    {nfmt.format(serie.votos[idxBairro.get(hover)!] || 0)} votos
                    {deltas ? (
                      <span className={deltas[idxBairro.get(hover)!] >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {' '}
                        ({deltas[idxBairro.get(hover)!] >= 0 ? '+' : ''}
                        {deltas[idxBairro.get(hover)!].toFixed(1)} pp)
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {' '}
                        ·{' '}
                        {((dadosCargo.totalPorBairro[idxBairro.get(hover)!] || 0) > 0
                          ? ((serie.votos[idxBairro.get(hover)!] || 0) /
                              dadosCargo.totalPorBairro[idxBairro.get(hover)!]) *
                            100
                          : 0
                        ).toFixed(1)}
                        %
                      </span>
                    )}
                  </p>
                ) : campeoes.get(hover) ? (
                  <p className="text-slate-400">
                    {campeoes.get(hover)!.nome}{' '}
                    <span className="text-slate-500">({campeoes.get(hover)!.partido})</span>
                  </p>
                ) : null}
              </div>
            )}

            {/* barra de escala nos modos contínuos */}
            {(modo === 'eleitorado' || (serie && !deltas) || deltas) && (
              <div className="absolute bottom-2 left-2 rounded-md border border-white/10 bg-black/70 px-2.5 py-1.5">
                <div
                  className="h-2 w-36 rounded-sm"
                  style={{
                    background: deltas
                      ? 'linear-gradient(90deg, hsl(0 75% 45%), #16181d, hsl(150 70% 45%))'
                      : modo === 'eleitorado'
                        ? 'linear-gradient(90deg, hsl(38 92% 18%), hsl(38 92% 60%))'
                        : 'linear-gradient(90deg, hsl(200 90% 14%), hsl(200 90% 60%))',
                  }}
                />
                <div className="flex justify-between pt-0.5 text-[10px] text-slate-400">
                  {deltas ? (
                    <>
                      <span>-{maxAbsDelta.toFixed(1)} pp</span>
                      <span>0</span>
                      <span>+{maxAbsDelta.toFixed(1)} pp</span>
                    </>
                  ) : modo === 'eleitorado' ? (
                    <>
                      <span>0</span>
                      <span>{nfmt.format(maxEleitores)} eleitores</span>
                    </>
                  ) : (
                    <>
                      <span>0%</span>
                      <span>{maxPctSerie.toFixed(1)}% do bairro</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-3">
            <Card className="border-white/10 bg-nexo-chrome">
              <CardContent className="p-4">
                {focado ? (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-widest text-slate-500">Bairro</p>
                      {pinado && (
                        <button
                          onClick={() => setPinado(null)}
                          className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                        >
                          <Pin className="h-3 w-3" /> solto
                        </button>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-slate-100">{focado.bairro}</p>
                    <div className="mt-2 space-y-1 text-xs text-slate-400">
                      <p className="flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5 text-amber-400" />
                        {nfmt.format(focado.eleitores)} eleitores · {focado.locais} local(is)
                      </p>
                      {modo !== 'eleitorado' && serie && focoIdx != null && dadosCargo && (
                        <p className="text-sky-300">
                          {serie.rotulo}: {nfmt.format(serie.votos[focoIdx] || 0)} votos (
                          {((dadosCargo.totalPorBairro[focoIdx] || 0) > 0
                            ? ((serie.votos[focoIdx] || 0) / dadosCargo.totalPorBairro[focoIdx]) * 100
                            : 0
                          ).toFixed(1)}
                          % dos nominais)
                          {deltas && (
                            <span className={deltas[focoIdx] >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {' '}· {deltas[focoIdx] >= 0 ? '+' : ''}
                              {deltas[focoIdx].toFixed(1)} pp vs {anoComp}
                            </span>
                          )}
                        </p>
                      )}
                      <Link
                        href={`/nexo/eleicoes/bairro/${encodeURIComponent(focado.bairro)}`}
                        className="inline-block text-[11px] text-sky-400 hover:text-sky-300"
                      >
                        ficha do bairro (2016/2020/2024) →
                      </Link>
                    </div>
                    {modo !== 'eleitorado' && topDoBairro.length > 0 && (
                      <div className="mt-3">
                        <p className="pb-1 text-[11px] uppercase tracking-widest text-slate-500">
                          Mais votados aqui ({anoVot})
                        </p>
                        <ul className="space-y-0.5 text-[11px]">
                          {topDoBairro.map((c, i) => (
                            <li key={c.nr} className="flex justify-between gap-2 text-slate-300">
                              <span className="truncate">
                                <span className="text-slate-400">{i + 1}.</span>{' '}
                                {c.personId ? (
                                  <Link href={`/nexo/pessoa/${encodeURIComponent(c.personId)}`} className="hover:text-sky-300">
                                    {c.nome}
                                  </Link>
                                ) : (
                                  c.nome
                                )}
                                <span className="text-slate-500"> {c.partido ?? ''}</span>
                              </span>
                              <span className="shrink-0 font-mono text-slate-400">
                                {nfmt.format(c.v)} · {c.pct.toFixed(1)}%
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    Passe o mouse sobre um bairro para ver{' '}
                    {modo === 'eleitorado' ? 'o eleitorado' : 'os mais votados'}; clique para fixar.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* painel contextual do modo */}
            {modo !== 'eleitorado' && serie ? (
              <Card className="border-white/10 bg-nexo-chrome">
                <CardContent className="p-4">
                  <p className="pb-2 text-[11px] uppercase tracking-widest text-slate-500">
                    {deltas ? `Maiores variações vs ${anoComp} (pp)` : `Onde ${serie.rotulo} é mais forte`}
                  </p>
                  <ul className="space-y-1 text-xs">
                    {topBairrosCand.map((b) => (
                      <li
                        key={b.bairro}
                        onMouseEnter={() => setHover(b.bairro)}
                        onMouseLeave={() => setHover(null)}
                        className={cn(
                          'flex cursor-default justify-between',
                          foco === b.bairro ? 'text-sky-300' : 'text-slate-400',
                        )}
                      >
                        <span className="truncate pr-2">{b.bairro}</span>
                        {b.delta != null ? (
                          <span className={cn('font-mono', b.delta >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {b.delta >= 0 ? '+' : ''}
                            {b.delta.toFixed(1)}
                          </span>
                        ) : (
                          <span className="font-mono">
                            {nfmt.format(b.v)}{'pct' in b && b.pct != null ? ` · ${(b.pct as number).toFixed(1)}%` : ''}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {candSel?.personId && (
                    <Link
                      href={`/nexo/pessoa/${encodeURIComponent(candSel.personId)}`}
                      className="mt-3 inline-block text-xs text-sky-400 hover:text-sky-300"
                    >
                      ver ficha completa →
                    </Link>
                  )}
                  {!candSel && partidoSel && (
                    <Link
                      href={`/nexo/eleicoes/partido/${encodeURIComponent(partidoSel)}`}
                      className="mt-3 inline-block text-xs text-sky-400 hover:text-sky-300"
                    >
                      página do partido →
                    </Link>
                  )}
                </CardContent>
              </Card>
            ) : modo !== 'eleitorado' && legendaCampeoes.length > 0 ? (
              <Card className="border-white/10 bg-nexo-chrome">
                <CardContent className="p-4">
                  <p className="pb-2 text-[11px] uppercase tracking-widest text-slate-500">
                    Campeão por bairro (partido) · {anoVot}
                  </p>
                  <ul className="space-y-1 text-xs">
                    {legendaCampeoes.map(([p, n]) => (
                      <li key={p} className="flex items-center justify-between text-slate-400">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ background: corPartido(p === '?' ? null : p) }}
                          />
                          {p}
                        </span>
                        <span className="font-mono">{n} bairro(s)</span>
                      </li>
                    ))}
                  </ul>
                  {foco && campeoes.get(foco) && (
                    <p className="mt-2 border-t border-white/5 pt-2 text-[11px] text-slate-400">
                      {foco}: <span className="text-slate-200">{campeoes.get(foco)!.nome}</span> (
                      {campeoes.get(foco)!.partido}) · {nfmt.format(campeoes.get(foco)!.votos)} votos
                    </p>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="border-white/10 bg-nexo-chrome">
                <CardContent className="p-4">
                  <p className="pb-2 text-[11px] uppercase tracking-widest text-slate-500">
                    Maiores eleitorados
                  </p>
                  <ul className="space-y-1 text-xs">
                    {[...paths]
                      .sort((a, b) => b.eleitores - a.eleitores)
                      .slice(0, 8)
                      .map((p) => (
                        <li
                          key={p.bairro}
                          onMouseEnter={() => setHover(p.bairro)}
                          onMouseLeave={() => setHover(null)}
                          className={cn(
                            'flex cursor-default justify-between',
                            foco === p.bairro ? 'text-amber-300' : 'text-slate-400',
                          )}
                        >
                          <span className="truncate pr-2">{p.bairro}</span>
                          <span className="font-mono">{nfmt.format(p.eleitores)}</span>
                        </li>
                      ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">
        Mapa aproximado: cada área é a zona de influência de um local de votação (Voronoi das
        coordenadas do TSE, recortado no contorno municipal do IBGE). "Bairro" = onde a pessoa
        VOTA, não onde mora. Votação = 1º turno, votos nominais por seção (TSE dados abertos).
        Em anos anteriores a 2024, seções extintas/renumeradas podem ficar de fora — o total
        exibido considera só o que foi casado com bairro. Evolução em pontos percentuais (pp)
        da fatia do candidato nos votos nominais do bairro.
      </p>
    </div>
  );
}
