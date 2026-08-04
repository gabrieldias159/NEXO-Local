'use client';

interface ScoreGaugeProps {
  confiabilidade: number;
  probabilidadeIrregularidade: number;
  probabilidadeEnquadramento?: number;
  /** Tamanho: 'sm' para tabelas, 'md' para cards (default). */
  size?: 'sm' | 'md';
}

function barColor(valor: number): string {
  if (valor >= 75) return 'bg-red-500';
  if (valor >= 50) return 'bg-orange-500';
  if (valor >= 25) return 'bg-amber-500';
  return 'bg-slate-500';
}

function rotulo(v: number): string {
  if (v >= 75) return 'alto';
  if (v >= 50) return 'médio';
  if (v >= 25) return 'baixo';
  return 'mínimo';
}

export function ScoreGauge({
  confiabilidade,
  probabilidadeIrregularidade,
  probabilidadeEnquadramento,
  size = 'md',
}: ScoreGaugeProps) {
  const h = size === 'sm' ? 'h-1.5' : 'h-2';
  const fontSize = size === 'sm' ? 'text-[10px]' : 'text-xs';

  const barras: { label: string; valor: number; key: string }[] = [
    { label: 'Confiab.', valor: confiabilidade, key: 'c' },
    { label: 'Irregularid.', valor: probabilidadeIrregularidade, key: 'i' },
  ];
  if (probabilidadeEnquadramento != null) {
    barras.push({ label: 'Enquadram.', valor: probabilidadeEnquadramento, key: 'e' });
  }

  return (
    <div className="flex gap-3">
      {barras.map((b) => (
        <div key={b.key} className="flex-1 min-w-0">
          <div className={`flex justify-between ${fontSize} text-slate-400 mb-0.5`}>
            <span>{b.label}</span>
            <span className="text-slate-300">{b.valor}%</span>
          </div>
          <div className={`w-full rounded-full bg-slate-700/50 ${h}`} role="progressbar" aria-valuenow={b.valor} aria-valuemin={0} aria-valuemax={100} aria-label={`${b.label}: ${b.valor}%`}>
            <div
              className={`${h} rounded-full transition-all duration-500 ${barColor(b.valor)}`}
              style={{ width: `${b.valor}%` }}
            />
          </div>
          <div className={`text-[10px] text-slate-500 mt-0.5`}>{rotulo(b.valor)}</div>
        </div>
      ))}
    </div>
  );
}
