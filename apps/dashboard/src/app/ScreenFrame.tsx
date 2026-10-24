import type { Envelope } from '@pulsegate/admin-contract';
import type { ReactNode } from 'react';
import { POLL_INTERVAL_MS, type Poll } from '../api/use-poll.ts';
import { formatAgo, formatClock } from '../data/format.ts';
import { ScreenSkeleton } from './ScreenSkeleton.tsx';
import './screens.css';

export interface ScreenFrameProps<T> {
  title: string;
  poll: Poll<T>;
  envelope: (data: T) => Envelope;
  children: (data: T) => ReactNode;
}

/**
 * Common frame for every screen (plan §4 states): loading skeleton, API unreachable (with retry), stale banner after
 * 2 missed polls (data stays visible with its last-updated time), refresh controls, and the window's provenance.
 */
export function ScreenFrame<T>({ title, poll, envelope, children }: ScreenFrameProps<T>) {
  const { data, error, stale, paused, lastUpdated } = poll;
  const meta = data === undefined ? undefined : envelope(data);
  const youngWindow =
    meta !== undefined &&
    meta.generatedAt - meta.window.collectingSince < meta.window.seconds * 1000;

  return (
    <section className="pg-screen" aria-labelledby="screen-title">
      <header className="pg-screen__header">
        <div>
          <h1 id="screen-title" className="pg-screen__title">
            {title}
          </h1>
          {meta !== undefined && (
            <p className="pg-hint">
              Last 5 minutes on instance <span className="pg-mono">{meta.instance.id}</span>
              {youngWindow &&
                ` · collecting for ${formatAgo(meta.generatedAt - meta.window.collectingSince)} (since the gateway started)`}
            </p>
          )}
        </div>
        <div className="pg-refresh" role="group" aria-label="Refresh">
          <span className="pg-refresh__status" data-testid="last-updated" aria-live="off">
            {lastUpdated === undefined ? 'Not loaded yet' : `Updated ${formatClock(lastUpdated)}`}
            {paused && ' · paused'}
          </span>
          <button
            type="button"
            className="pg-button pg-button--secondary"
            aria-pressed={paused}
            onClick={() => {
              poll.setPaused(!paused);
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="pg-button pg-button--secondary"
            data-testid="refresh-now"
            onClick={poll.refresh}
          >
            Refresh now
          </button>
        </div>
      </header>

      {stale && lastUpdated !== undefined && (
        <div className="pg-banner pg-banner--warning" role="status" data-testid="stale-banner">
          Showing data from {formatClock(lastUpdated)}. The last {String(poll.misses)} refreshes
          failed
          {error === undefined ? '' : ` (${error.message})`}; retrying every{' '}
          {String(POLL_INTERVAL_MS / 1000)} s.
        </div>
      )}

      {data === undefined && error !== undefined && (
        <div className="pg-banner pg-banner--danger" role="alert" data-testid="screen-error">
          <span>
            {error.kind === 'unreachable'
              ? 'The admin API could not be reached. Is the gateway running?'
              : `Could not load this screen: ${error.message}`}
          </span>
          <button type="button" className="pg-button pg-button--secondary" onClick={poll.refresh}>
            Try again
          </button>
        </div>
      )}

      {data === undefined ? error === undefined && <ScreenSkeleton /> : children(data)}
    </section>
  );
}

/** Shown instead of flat, empty charts when the window has no traffic yet. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pg-card pg-empty" data-testid="empty-state">
      <h2 className="pg-empty__title">{title}</h2>
      <p className="pg-hint">{children}</p>
    </div>
  );
}
