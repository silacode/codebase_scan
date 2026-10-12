import { useCallback, useEffect } from 'react';
import type { Scan } from '../types/scan-contracts';

export const scanIdentity = () => new URLSearchParams(location.search).get('scan') ?? '';

export function useScanNavigation(transition: (next: string, initial?: Scan) => void) {
  const navigate = useCallback(
    (next: string, push = true, initial?: Scan) => {
      if (push)
        history.pushState({}, '', next ? `?scan=${encodeURIComponent(next)}` : location.pathname);
      transition(next, initial);
    },
    [transition],
  );

  useEffect(() => {
    const onPop = () => navigate(scanIdentity(), false);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [navigate]);
  return { navigate, clearUrl: () => history.pushState({}, '', location.pathname) };
}
