/**
 * Where the admin token lives in the browser (ADR-0037): `sessionStorage`, so it is scoped to one tab and gone when
 * the tab closes. Never `localStorage`, cookies or URLs. If storage is unavailable (private mode, blocked site data),
 * the token is kept in memory for the page's lifetime instead, so the dashboard still works.
 */
export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

export const TOKEN_KEY = 'pulsegate.adminToken';

export function createTokenStore(storage: () => Storage = () => window.sessionStorage): TokenStore {
  let memory: string | undefined;
  const session = (): Storage | undefined => {
    try {
      return storage();
    } catch {
      return undefined;
    }
  };
  return {
    get() {
      try {
        return session()?.getItem(TOKEN_KEY) ?? memory;
      } catch {
        return memory;
      }
    },
    set(token) {
      memory = token;
      try {
        session()?.setItem(TOKEN_KEY, token);
      } catch {
        // Quota or policy: the in-memory copy is enough for this page.
      }
    },
    clear() {
      memory = undefined;
      try {
        session()?.removeItem(TOKEN_KEY);
      } catch {
        // Nothing stored.
      }
    },
  };
}
