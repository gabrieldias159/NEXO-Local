'use client';

import * as React from 'react';

/**
 * Hook que avalia uma media query CSS e retorna `true` quando ela bate.
 *
 * Em SSR retorna `false` no primeiro render para evitar hydration mismatch;
 * o valor real é aplicado no `useEffect` após mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setMatches('matches' in e ? e.matches : mql.matches);
    };
    onChange(mql);
    if ('addEventListener' in mql) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Fallback para browsers antigos
    // @ts-expect-error legacy API
    mql.addListener(onChange);
    return () => {
      // @ts-expect-error legacy API
      mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}
