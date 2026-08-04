'use client';

/**
 * Primitivas de animação do NEXO (framer-motion via LazyMotion — só o feature
 * set `domAnimation`, ~15kb em vez dos ~34kb do `motion` completo). Montado UMA
 * vez pelo NexoShell (`NexoMotionProvider`); as páginas usam `m.*` e os
 * componentes daqui. `reducedMotion="user"` respeita prefers-reduced-motion
 * globalmente — nenhum componente precisa checar à mão.
 *
 * REGRAS (não violar): nada de animar layout de tabela a cada tecla de filtro;
 * nada de loop infinito além do dot de status do shell; stagger com cap de itens
 * (não escalonar tabelas de centenas de linhas).
 */
import { LazyMotion, domAnimation, MotionConfig, m, useReducedMotion, useMotionValue, useSpring, animate } from 'framer-motion';
import { useEffect, useState } from 'react';

export { m };

export function NexoMotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Entrada de página: fade + rise sutil. Sem exit (App Router é frágil nisso). */
export function NexoEntrada({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/** Container de stagger (grids de cards/KPIs). Cap ~10 filhos — além disso o
 *  escalonamento vira ruído; passe `cap` menor se precisar. */
export function NexoStagger({ children, className, cap = 10 }: { children: React.ReactNode; className?: string; cap?: number }) {
  return (
    <m.div
      initial="oculto"
      animate="visivel"
      variants={{ visivel: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } } }}
      className={className}
      custom={cap}
    >
      {children}
    </m.div>
  );
}

export function NexoItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <m.div
      variants={{
        oculto: { opacity: 0, y: 6 },
        visivel: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
      }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/** Número que "conta" até o valor (KPIs). Respeita reduced-motion (valor direto). */
export function NumberTicker({
  valor,
  className,
  formato = (n: number) => Math.round(n).toLocaleString('pt-BR'),
  duracaoMs = 700,
}: {
  valor: number;
  className?: string;
  formato?: (n: number) => string;
  duracaoMs?: number;
}) {
  const reduz = useReducedMotion();
  const mv = useMotionValue(0);
  const [texto, setTexto] = useState(() => formato(reduz ? valor : 0));
  useEffect(() => {
    if (reduz) {
      setTexto(formato(valor));
      return;
    }
    const controls = animate(mv, valor, {
      duration: duracaoMs / 1000,
      ease: 'easeOut',
      onUpdate: (v) => setTexto(formato(v)),
    });
    return () => controls.stop();
  }, [valor, reduz, duracaoMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className={className}>{texto}</span>;
}

/** Barra de score com fill animado no mount (0→pct). */
export function BarraScore({ pct, cor = 'bg-amber-500', className }: { pct: number; cor?: string; className?: string }) {
  const reduz = useReducedMotion();
  const alvo = Math.max(0, Math.min(100, pct));
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-white/10 ${className ?? ''}`}>
      <m.div
        className={`h-full rounded-full ${cor}`}
        initial={{ width: reduz ? `${alvo}%` : 0 }}
        animate={{ width: `${alvo}%` }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
    </div>
  );
}

/** Chevron que gira ao expandir. */
export function ChevronGira({ aberto, className }: { aberto: boolean; className?: string }) {
  return (
    <m.span animate={{ rotate: aberto ? 90 : 0 }} transition={{ duration: 0.15 }} className={`inline-flex ${className ?? ''}`}>
      ▸
    </m.span>
  );
}

export { useReducedMotion, useMotionValue, useSpring };
