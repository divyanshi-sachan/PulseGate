import { useCallback } from 'react';
import { usePoll } from '../api/use-poll.ts';
import { ScreenFrame } from '../app/ScreenFrame.tsx';
import { Badge } from '../charts/StatusBadge.tsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.tsx';
import { rejectionPoints } from '../data/chart-data.ts';
import { formatCount, formatPercent } from '../data/format.ts';
import type { ScreenProps } from './types.ts';

const REJECTION_SERIES = [
  { key: 'rejectionRate', label: 'Rejected', className: 'pg-series--warning' },
] as const;

/** Rate limits (plan §6): backend health and degraded state, per-route policy, rejections and their trend. */
export default function RateLimits({ api, onUnauthorized }: ScreenProps) {
  const load = useCallback((signal: AbortSignal) => api.rateLimits(signal), [api]);
  const poll = usePoll(load, onUnauthorized);
  return (
    <ScreenFrame title="Rate limits" poll={poll} envelope={(d) => d}>
      {(data) => {
        const { backend } = data;
        const active = data.routes.filter(
          (r) => r.series.window.counters.rl.allowed + r.series.window.counters.rl.rejected > 0,
        );
        return (
          <>
            {backend.degraded && (
              <div
                className="pg-banner pg-banner--warning"
                role="status"
                data-testid="rate-limit-degraded"
              >
                Redis is unavailable: limits are enforced per instance (fail-open) until it
                recovers.
              </div>
            )}
            {backend.kind === 'redis' && !backend.healthy && !backend.degraded && (
              <div
                className="pg-banner pg-banner--danger"
                role="status"
                data-testid="rate-limit-unavailable"
              >
                Redis is unavailable: rate-limited routes answer 503 (fail-closed) until it
                recovers.
              </div>
            )}
            <section className="pg-card pg-panel" aria-labelledby="rl-backend">
              <div className="pg-panel__header">
                <h2 id="rl-backend" className="pg-section-title">
                  Backend
                </h2>
                <Badge tone={backend.kind === 'redis' ? 'info' : 'neutral'}>
                  {backend.kind === 'redis' ? 'Redis (shared)' : 'Local (per instance)'}
                </Badge>
                <span data-testid="rate-limit-health">
                  <Badge tone={backend.healthy ? 'success' : 'danger'}>
                    {backend.healthy ? 'Healthy' : 'Unavailable'}
                  </Badge>
                </span>
              </div>
              <dl className="pg-details">
                {backend.target !== null && (
                  <div>
                    <dt>Redis</dt>
                    <dd className="pg-mono">{backend.target}</dd>
                  </div>
                )}
                {data.redisFailurePolicy !== null && (
                  <div>
                    <dt>When Redis fails</dt>
                    <dd>
                      {data.redisFailurePolicy === 'open'
                        ? 'Fail open (local limits)'
                        : 'Fail closed (503)'}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Local bucket cap</dt>
                  <dd>{formatCount(data.maxBuckets)}</dd>
                </div>
              </dl>
            </section>
            <div className="pg-card pg-table-wrap">
              <table className="pg-table">
                <caption className="pg-visually-hidden">
                  Rate limits per route over the last 5 minutes
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Route</th>
                    <th scope="col">Burst</th>
                    <th scope="col">Refill</th>
                    <th scope="col">Allowed</th>
                    <th scope="col">Rejected</th>
                    <th scope="col">Rejection rate</th>
                    <th scope="col">Degraded</th>
                    <th scope="col">Limiter unavailable</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.map((r) => {
                    const { counters, rates } = r.series.window;
                    return (
                      <tr key={r.id}>
                        <td className="pg-mono">{r.id}</td>
                        <td>{formatCount(r.policy.capacity)}</td>
                        <td>{String(r.policy.refillRatePerSecond)}/s</td>
                        <td>{formatCount(counters.rl.allowed)}</td>
                        <td>{formatCount(counters.rl.rejected)}</td>
                        <td data-testid={`rejection-rate-${r.id}`}>
                          {formatPercent(rates.rateLimitRejectionRate)}
                        </td>
                        <td>{formatCount(counters.rl.degraded)}</td>
                        <td>{formatPercent(rates.rateLimiterUnavailableRate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {active.length > 0 && (
              <div className="pg-chart-grid">
                {active.map((r) => (
                  <TimeSeriesChart
                    key={r.id}
                    title={`${r.id}: rejections`}
                    description="Share of limiter decisions that rejected the request (429)"
                    points={rejectionPoints(r.series.buckets)}
                    series={REJECTION_SERIES}
                    unit="%"
                  />
                ))}
              </div>
            )}
          </>
        );
      }}
    </ScreenFrame>
  );
}
