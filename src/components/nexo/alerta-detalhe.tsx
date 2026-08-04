'use client';

/**
 * NEXO — Detalhe de indício (drill-down).
 *
 * Recebe um `AlertaDetectado` e abre um painel lateral (Sheet) com TUDO que o
 * detector produziu: scores explicados, evidências, fundamento legal e o
 * raciocínio do detector. Sempre como indício a apurar — nunca acusação.
 *
 * Uso: <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
 * O painel abre quando `alerta` é não-nulo; o Sheet do shadcn já cuida de
 * ESC para fechar, trap de foco e overlay.
 */
import {
  ShieldQuestion,
  Scale,
  FileSearch,
  Gauge,
  TriangleAlert,
  Building2,
  ScrollText,
  FileText,
  User,
  Landmark,
  Info,
  Lightbulb,
  Link2,
} from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { AlertaDetectado, Classificacao } from '@/lib/nexo/detectores';
import { mascararDoc } from '@/lib/nexo/normalizar';
import { FontesProvas, ProvaEvidencia } from './fontes-provas';

const CLASS_META: Record<
  Classificacao,
  { rotulo: string; badge: string; barra: string }
> = {
  critico: {
    rotulo: 'Crítico',
    badge: 'border-red-500/30 bg-red-500/10 text-red-300',
    barra: 'bg-red-500',
  },
  suspeita: {
    rotulo: 'Suspeita',
    badge: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    barra: 'bg-orange-500',
  },
  atencao: {
    rotulo: 'Atenção',
    badge: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    barra: 'bg-amber-500',
  },
  informativo: {
    rotulo: 'Informativo',
    badge: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
    barra: 'bg-slate-500',
  },
};

const SUJEITO_META: Record<
  AlertaDetectado['sujeitoTipo'],
  { rotulo: string; icon: React.ComponentType<{ className?: string }> }
> = {
  fornecedor: { rotulo: 'Fornecedor', icon: Building2 },
  contrato: { rotulo: 'Contrato', icon: ScrollText },
  empenho: { rotulo: 'Empenho', icon: FileText },
  servidor: { rotulo: 'Servidor', icon: User },
  orgao: { rotulo: 'Órgão', icon: Landmark },
};

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2,
  });
}

function dataPtBr(d: string | null | undefined): string | null {
  if (!d) return null;
  // Aceita 'YYYY-MM-DD' ou ISO; cai pro texto cru se não parsear.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dt = new Date(d);
  if (!Number.isNaN(dt.getTime())) return dt.toLocaleDateString('pt-BR');
  return d;
}

/** Detecta CPF de pessoa física no rótulo do sujeito e mascara (LGPD). */
function rotuloSeguro(alerta: AlertaDetectado): string {
  const cru = alerta.sujeitoRotulo || alerta.sujeitoId || '—';
  // 11 dígitos contínuos = CPF; mascara conforme @/lib/nexo/normalizar.
  return cru.replace(/\b\d{11}\b/g, (m) => mascararDoc(m));
}

/** Barra/medidor visual de um score 0–100 com legenda explicativa. */
function ScoreMedidor({
  rotulo,
  descricao,
  valor,
  cor,
}: {
  rotulo: string;
  descricao: string;
  valor: number;
  cor: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(valor)));
  return (
    <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-slate-200">{rotulo}</span>
        <span className="font-mono text-sm text-slate-100">{pct}%</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full ${cor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {descricao}
      </p>
    </div>
  );
}

function Secao({
  icon: Icon,
  titulo,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5 text-amber-400/80" />
        {titulo}
      </h3>
      {children}
    </section>
  );
}

export interface AlertaDetalheProps {
  /** Indício selecionado; quando `null` o painel fica fechado. */
  alerta: AlertaDetectado | null;
  /** Chamado ao fechar o painel (ESC, overlay ou botão X). */
  onClose: () => void;
}

export function AlertaDetalhe({ alerta, onClose }: AlertaDetalheProps) {
  const meta = alerta ? CLASS_META[alerta.classificacao] : null;
  const sujeito = alerta ? SUJEITO_META[alerta.sujeitoTipo] : null;

  return (
    <Sheet open={alerta !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-l border-white/5 bg-nexo-surface p-0 sm:max-w-xl"
      >
        {alerta && meta && sujeito && (
          <div className="flex flex-col">
            {/* Cabeçalho */}
            <div className="space-y-3 border-b border-white/5 bg-nexo-chrome p-5 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-[10px] uppercase ${meta.badge}`}
                >
                  {meta.rotulo}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-white/10 font-mono text-[10px] text-slate-400"
                >
                  {alerta.detectorId}
                </Badge>
                <span className="text-[11px] text-slate-500">
                  {alerta.categoria}
                </span>
              </div>
              <h2 className="text-base font-semibold leading-snug text-slate-100">
                {alerta.titulo}
              </h2>
              <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <ShieldQuestion className="h-3.5 w-3.5 text-amber-400/70" />
                Detector {alerta.detectorId} — {alerta.detectorNome}
              </p>
            </div>

            <div className="space-y-6 p-5">
              {/* Descrição */}
              <Secao icon={Info} titulo="Descrição">
                <p className="text-sm leading-relaxed text-slate-300">
                  {alerta.descricao}
                </p>
              </Secao>

              {/* Scores explicados */}
              <Secao icon={Gauge} titulo="Scores — explicados">
                <div className="space-y-3">
                  <ScoreMedidor
                    rotulo="Confiabilidade documental"
                    descricao="Força da prova: o quanto a evidência se apoia em documento oficial, fonte primária, data e referência verificável. Quanto maior, mais sólido o lastro do indício."
                    valor={alerta.scores.confiabilidade}
                    cor="bg-sky-500"
                  />
                  <ScoreMedidor
                    rotulo="Probabilidade de irregularidade"
                    descricao="O quanto o padrão destoa da normalidade: repetição, valor atípico, proximidade de limite legal ou ausência de justificativa. Mede o desvio observado — não é percentual de ilícito."
                    valor={alerta.scores.probabilidadeIrregularidade}
                    cor={meta.barra}
                  />
                </div>
              </Secao>

              {/* Raciocínio do detector */}
              <Secao icon={Lightbulb} titulo="Raciocínio do detector">
                <p className="rounded-md border border-white/5 bg-nexo-chrome p-3 text-[13px] leading-relaxed text-slate-400">
                  {alerta.explicacao}
                </p>
              </Secao>

              {/* Sujeito e valor */}
              <Secao icon={sujeito.icon} titulo="Sujeito e valor envolvido">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">
                      {sujeito.rotulo}
                    </p>
                    <p className="mt-1 break-words text-sm text-slate-200">
                      {rotuloSeguro(alerta)}
                    </p>
                  </div>
                  <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">
                      Valor envolvido
                    </p>
                    <p className="mt-1 font-mono text-sm text-amber-300">
                      {alerta.valorEnvolvido > 0
                        ? brl(alerta.valorEnvolvido)
                        : 'a apurar'}
                    </p>
                  </div>
                </div>
              </Secao>

              {/* Evidências */}
              <Secao
                icon={FileSearch}
                titulo={`Evidências coletadas (${alerta.evidencias.length})`}
              >
                {alerta.evidencias.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    Nenhuma evidência discriminada — ver descrição e raciocínio
                    acima.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {alerta.evidencias.map((ev, i) => {
                      const dt = dataPtBr(ev.data);
                      return (
                        <li
                          key={i}
                          className="rounded-md border border-white/5 bg-nexo-chrome p-3"
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-500/10 font-mono text-[10px] text-amber-300">
                              {i + 1}
                            </span>
                            <p className="flex-1 text-[13px] leading-relaxed text-slate-300">
                              {ev.resumo}
                            </p>
                          </div>
                          {(ev.valor != null || dt || ev.ref) && (
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-7 text-[11px]">
                              {ev.valor != null && (
                                <span className="font-mono text-amber-300/90">
                                  {brl(ev.valor)}
                                </span>
                              )}
                              {dt && (
                                <span className="text-slate-500">
                                  Data: {dt}
                                </span>
                              )}
                              {ev.ref && (
                                <span className="break-all text-slate-500">
                                  Ref.: {ev.ref}
                                </span>
                              )}
                            </div>
                          )}
                          {/* Prova documental clicável NA própria evidência. */}
                          {ev.procedencia && (
                            <div className="pl-7">
                              <ProvaEvidencia prova={ev.procedencia} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Secao>

              {/*
                Fontes & Provas — rastro probatório consolidado. Cada evidência já
                exibe sua prova clicável inline (acima); este bloco é o índice
                agregado, útil quando há 2+ provas. Quando NENHUMA evidência tem
                prova, mostra o empty-state honesto via <FontesProvas/>.
              */}
              {(() => {
                const provas = alerta.evidencias.flatMap((e) =>
                  e.procedencia ? [e.procedencia] : [],
                );
                if (provas.length === 1) return null; // já visível na evidência
                return (
                  <Secao
                    icon={Link2}
                    titulo={
                      provas.length === 0
                        ? 'Fontes & Provas'
                        : `Fontes & Provas — consolidado (${provas.length})`
                    }
                  >
                    <FontesProvas provas={provas} />
                  </Secao>
                );
              })()}

              {/* Fundamento legal */}
              <Secao icon={Scale} titulo="Fundamento legal">
                {alerta.fundamentoLegal.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    Nenhum dispositivo legal associado.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {alerta.fundamentoLegal.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-2 text-[13px] text-slate-300"
                      >
                        <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Secao>
            </div>

            {/* Rodapé — disclaimer */}
            <div className="flex items-start gap-2 border-t border-white/5 bg-nexo-chrome p-5 text-[11px] leading-relaxed text-slate-500">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/70" />
              <p>
                Este é um <strong className="text-slate-400">indício</strong>,
                nunca uma acusação. Os scores medem desvio estatístico e força
                documental — não atestam ilícito. Requer apuração documental e
                contraditório antes de qualquer juízo de valor.
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default AlertaDetalhe;
