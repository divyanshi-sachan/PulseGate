import { useCallback } from 'react';
import type { AdminApi } from '../api/client.ts';
import { useResource } from '../api/use-resource.ts';
import { ScreenSkeleton } from '../app/ScreenSkeleton.tsx';
import { formatClock, formatCount, formatMs, formatPercent, formatRps } from '../data/format.ts';
import './overview.css';

export interface OverviewProps {
  api: AdminApi;
  onUnauthorized: () => void;
}

/**
 * Overview (step 4 scaffold): window KPIs from /admin/api/stats. Trend charts, polling and the remaining screens
 * arrive in step 5.
 */
export default function Overview({ api, onUnauthorized }: OverviewProps) {
  const load = useCallback((signal: AbortSignal) => api.stats(signal), [api]);
  const stats = useResource(load, onUnauthorized);

  if (stats.status === 'loading') return <ScreenSkeleton />;
  if (stats.status === 'error') {
    return (
      <div className="pg-banner pg-banner--danger" role="alert">
        {stats.error.kind === 'unreachable'
          ? 'The admin API could not be reached.'
          : `Could not load statistics: ${stats.error.message}`}
      </div>
    );
  }

  const { window: window5m } = stats.data.total;
  const p95 = window5m.latency.p95;
  return (
    <section className="pg-overview" aria-labelledby="overview-title">
      <div>
        <h1 id="overview-title" className="pg-overview__title">
          Overview
        </h1>
        <p className="pg-hint">
          Last 5 minutes on instance <span className="pg-mono">{stats.data.instance.id}</span>,
          updated {formatClock(stats.data.generatedAt)}
        </p>
      </div>
      <dl className="pg-kpis">
        <div className="pg-card pg-kpi">
          <dt>Requests</dt>
          <dd data-testid="kpi-requests">{formatCount(window5m.counters.requests)}</dd>
        </div>
        <div className="pg-card pg-kpi">
          <dt>Throughput</dt>
          <dd data-testid="kpi-rps">{formatRps(window5m.rates.rps)}</dd>
        </div>
        <div className="pg-card pg-kpi">
          <dt>Server error rate</dt>
          <dd data-testid="kpi-error-rate">{formatPercent(window5m.rates.errorRate)}</dd>
        </div>
        <div className="pg-card pg-kpi">
          <dt>p95 latency</dt>
          <dd data-testid="kpi-p95">{formatMs(p95.value)}</dd>
          {p95.value !== null && p95.confidence !== 'adequate' && (
            <span className="pg-kpi__note">
              {p95.confidence} confidence, n={formatCount(p95.effectiveSamples)}
            </span>
          )}
        </div>
      </dl>
    </section>
  );
}
