import { MIN_ADMIN_TOKEN_LENGTH } from '@pulsegate/admin-contract';
import { useId, useState, type SubmitEvent } from 'react';
import { ApiError, type AdminApi } from '../api/client.ts';
import './token-gate.css';

export interface TokenGateProps {
  /** Builds a client for a candidate token; the gate verifies it against /admin/api/stats before accepting. */
  connect: (token: string) => AdminApi;
  onAuthenticated: (token: string) => void;
  /** Shown when the gate is reached because a stored token stopped working. */
  notice?: string | undefined;
}

type Problem =
  | { kind: 'short' }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }
  | { kind: 'other'; message: string };

function describe(problem: Problem): string {
  switch (problem.kind) {
    case 'short':
      return `Admin tokens are at least ${String(MIN_ADMIN_TOKEN_LENGTH)} characters long.`;
    case 'rejected':
      return 'This token was rejected. Check the ADMIN_TOKEN the gateway was started with.';
    case 'unreachable':
      return 'The admin API could not be reached. Is the gateway running with ADMIN_TOKEN set?';
    case 'other':
      return problem.message;
  }
}

/**
 * Asks for the admin token once per tab (ADR-0037). The token is checked against the API before it is kept, and it
 * never appears in the URL, the page or the console.
 */
export function TokenGate({ connect, onAuthenticated, notice }: TokenGateProps) {
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<Problem | undefined>();
  const [checking, setChecking] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = token.trim();
    if (candidate.length < MIN_ADMIN_TOKEN_LENGTH) {
      setProblem({ kind: 'short' });
      return;
    }
    setChecking(true);
    setProblem(undefined);
    try {
      await connect(candidate).stats();
      onAuthenticated(candidate);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'unauthorized')
        setProblem({ kind: 'rejected' });
      else if (error instanceof ApiError && error.kind === 'unreachable') {
        setProblem({ kind: 'unreachable' });
      } else {
        setProblem({
          kind: 'other',
          message: error instanceof Error ? error.message : 'Unexpected error',
        });
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="pg-gate">
      <section className="pg-card pg-gate__card" aria-labelledby={`${inputId}-title`}>
        <div className="pg-gate__brand" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={32} height={32} />
        </div>
        <h1 id={`${inputId}-title`} className="pg-gate__title">
          PulseGate admin
        </h1>
        <p className="pg-gate__lead">
          Enter the gateway&apos;s admin token. It is kept only for this browser tab.
        </p>
        {notice !== undefined && (
          <div className="pg-banner pg-banner--warning" role="status">
            {notice}
          </div>
        )}
        <form className="pg-gate__form" onSubmit={(event) => void submit(event)} noValidate>
          <div className="pg-field">
            <label className="pg-label" htmlFor={inputId}>
              Admin token
            </label>
            <input
              id={inputId}
              className="pg-input pg-mono"
              type="password"
              name="admin-token"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
              aria-invalid={problem !== undefined}
              aria-describedby={problem === undefined ? hintId : `${hintId} ${errorId}`}
              required
            />
            <p id={hintId} className="pg-hint">
              The value of <code className="pg-mono">ADMIN_TOKEN</code> on the gateway.
            </p>
          </div>
          {problem !== undefined && (
            <div id={errorId} className="pg-banner pg-banner--danger" role="alert">
              {describe(problem)}
            </div>
          )}
          <button className="pg-button pg-button--primary" type="submit" disabled={checking}>
            {checking ? 'Checking…' : 'Open dashboard'}
          </button>
        </form>
      </section>
    </main>
  );
}
