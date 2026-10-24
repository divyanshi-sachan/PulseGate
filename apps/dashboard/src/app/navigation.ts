import { useCallback, useEffect, useState } from 'react';
import { UI_BASE } from './base.ts';

export const SCREENS = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'routes', label: 'Routes', path: 'routes' },
  { id: 'upstreams', label: 'Upstreams', path: 'upstreams' },
  { id: 'cache', label: 'Cache', path: 'cache' },
  { id: 'rate-limits', label: 'Rate limits', path: 'rate-limits' },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];

const BASE = UI_BASE;

export function screenFromPath(pathname: string): ScreenId {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/\/+$/, '') : '';
  return SCREENS.find((s) => s.path === rest)?.id ?? 'overview';
}

export function pathOf(id: ScreenId): string {
  return `${BASE}${SCREENS.find((s) => s.id === id)?.path ?? ''}`;
}

/**
 * Screen selection in the URL (History API, no router dependency): links are real, reload keeps the screen, and the
 * gateway serves index.html for these extensionless paths (ADR-0040).
 */
export function useScreen(): [ScreenId, (id: ScreenId) => void] {
  const [screen, setScreen] = useState<ScreenId>(() => screenFromPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => {
      setScreen(screenFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  const navigate = useCallback((id: ScreenId) => {
    if (pathOf(id) !== window.location.pathname) window.history.pushState(null, '', pathOf(id));
    setScreen(id);
  }, []);
  return [screen, navigate];
}
