import { lazy, Suspense, useCallback, useMemo, useState, type ComponentType } from 'react';
import { createAdminApi, type AdminApi } from '../api/client.ts';
import { createTokenStore, type TokenStore } from '../auth/token-store.ts';
import { ScreenSkeleton } from './ScreenSkeleton.tsx';
import { pathOf, SCREENS, useScreen, type ScreenId } from './navigation.ts';
import { TokenGate } from './TokenGate.tsx';
import type { ScreenProps } from '../screens/types.ts';
import './shell.css';

// Screens and the chart library load only after the token gate, one chunk per screen (plan §3).
const SCREEN_COMPONENTS: Record<ScreenId, ComponentType<ScreenProps>> = {
  overview: lazy(() => import('../screens/Overview.tsx')),
  routes: lazy(() => import('../screens/Routes.tsx')),
  upstreams: lazy(() => import('../screens/Upstreams.tsx')),
  cache: lazy(() => import('../screens/Cache.tsx')),
  'rate-limits': lazy(() => import('../screens/RateLimits.tsx')),
};

export interface AppProps {
  store?: TokenStore;
  connect?: (token: string) => AdminApi;
}

const defaultStore = createTokenStore();
const defaultConnect = (token: string) => createAdminApi({ token });

export const SESSION_EXPIRED = 'The admin token is no longer accepted. Enter it again to continue.';

export function App({ store = defaultStore, connect = defaultConnect }: AppProps) {
  const [token, setToken] = useState(() => store.get());
  const [notice, setNotice] = useState<string | undefined>();
  const [screen, navigate] = useScreen();
  const api = useMemo(() => (token === undefined ? undefined : connect(token)), [token, connect]);

  const signOut = useCallback(
    (reason?: string) => {
      store.clear();
      setToken(undefined);
      setNotice(reason);
    },
    [store],
  );
  const onUnauthorized = useCallback(() => {
    signOut(SESSION_EXPIRED);
  }, [signOut]);

  if (api === undefined) {
    return (
      <TokenGate
        connect={connect}
        notice={notice}
        onAuthenticated={(accepted) => {
          store.set(accepted);
          setNotice(undefined);
          setToken(accepted);
        }}
      />
    );
  }

  const Screen = SCREEN_COMPONENTS[screen];
  return (
    <div className="pg-shell">
      <a className="pg-skip-link" href="#main">
        Skip to content
      </a>
      <header className="pg-shell__header">
        <div className="pg-shell__bar">
          <span className="pg-shell__brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
            PulseGate
          </span>
          <nav className="pg-nav" aria-label="Screens">
            <ul>
              {SCREENS.map((s) => (
                <li key={s.id}>
                  <a
                    href={pathOf(s.id)}
                    className="pg-nav__link"
                    aria-current={s.id === screen ? 'page' : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                        return;
                      event.preventDefault();
                      navigate(s.id);
                    }}
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <span className="pg-shell__spacer" />
          <button
            className="pg-button pg-button--secondary"
            type="button"
            onClick={() => {
              signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main id="main" className="pg-shell__main">
        <Suspense fallback={<ScreenSkeleton />}>
          <Screen key={screen} api={api} onUnauthorized={onUnauthorized} />
        </Suspense>
      </main>
    </div>
  );
}
