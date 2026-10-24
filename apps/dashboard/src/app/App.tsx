import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { createAdminApi, type AdminApi } from '../api/client.ts';
import { createTokenStore, type TokenStore } from '../auth/token-store.ts';
import { ScreenSkeleton } from './ScreenSkeleton.tsx';
import { TokenGate } from './TokenGate.tsx';
import './shell.css';

// Screens (and, from step 5, the chart library) load only after the token gate (plan §3).
const Overview = lazy(() => import('../screens/Overview.tsx'));

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

  return (
    <div className="pg-shell">
      <header className="pg-shell__header">
        <div className="pg-shell__bar">
          <span className="pg-shell__brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
            PulseGate
          </span>
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
      <main className="pg-shell__main">
        <Suspense fallback={<ScreenSkeleton />}>
          <Overview api={api} onUnauthorized={onUnauthorized} />
        </Suspense>
      </main>
    </div>
  );
}
