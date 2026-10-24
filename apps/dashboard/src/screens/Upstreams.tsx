import { useCallback } from 'react';
import { usePoll } from '../api/use-poll.ts';
import { Kpi } from '../app/Kpi.tsx';
import { ScreenFrame } from '../app/ScreenFrame.tsx';
import { BreakerBadge } from '../charts/StatusBadge.tsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.tsx';
import { LATENCY_SERIES, latencyPoints, upstreamFailurePoints } from '../data/chart-data.ts';
import { formatCount, formatMs, formatPercent } from '../data/format.ts';
import type { ScreenProps } from './types.ts';

const FAILURE_SERIES = [
  { key: 'failureRate', label: 'Failed attempts', className: 'pg-series--danger' },
] as const;

/** Upstreams (plan §6): breaker state badges, attempt failure rate and attempt latency trends. */
export default function Upstreams({ api, onUnauthorized }: ScreenProps) {
  const load = useCallback((signal: AbortSignal) => api.upstreams(signal), [api]);
  const poll = usePoll(load, onUnauthorized);
  return (
    <ScreenFrame title="Upstreams" poll={poll} envelope={(d) => d}>
      {(data) => (
        <>
          {data.upstreams.map((u) => {
            const { counters, rates } = u.series.window;
            const s = u.breaker.settings;
            return (
              <section
                key={u.id}
                className="pg-card pg-panel"
                aria-labelledby={`upstream-${u.id}`}
                data-testid={`upstream-${u.id}`}
              >
                <div className="pg-panel__header">
                  <h2 id={`upstream-${u.id}`} className="pg-section-title pg-mono">
                    {u.id}
                  </h2>
                  <BreakerBadge state={u.breaker.state} testId={`breaker-${u.id}`} />
                  <span className="pg-subtle pg-mono">{u.baseUrl}</span>
                </div>
                <dl className="pg-kpis">
                  <Kpi
                    label="Attempt failure rate"
                    value={formatPercent(rates.upstreamFailureRate)}
                    note={`${formatCount(counters.attempts.failure)} of ${formatCount(counters.attempts.success + counters.attempts.failure)} decided attempts`}
                    testId={`upstream-failure-rate-${u.id}`}
                  />
                  <Kpi
                    label="Attempts"
                    value={formatCount(
                      counters.attempts.success +
                        counters.attempts.failure +
                        counters.attempts.aborted,
                    )}
                    note={`${formatCount(counters.attempts.aborted)} aborted by clients, ${formatCount(counters.retries)} retries`}
                  />
                  <Kpi
                    label="Consecutive failures"
                    value={`${formatCount(u.breaker.consecutiveFailures)} / ${formatCount(s.failureThreshold)}`}
                    note={
                      u.breaker.state === 'closed'
                        ? 'opens the breaker at the threshold'
                        : 'reset when the breaker opened; counting resumes once it closes'
                    }
                  />
                  <Kpi
                    label="p95 attempt latency"
                    value={formatMs(u.series.window.latency.p95.value)}
                  />
                </dl>
                <p className="pg-hint">
                  Breaker: opens after {String(s.failureThreshold)} consecutive failures for{' '}
                  {formatMs(s.openDurationMs)}; then up to {String(s.halfOpenMaxRequests)} probe(s),
                  closing after {String(s.halfOpenSuccessThreshold)} success(es). Failure statuses:{' '}
                  {s.failureStatuses.join(', ')}.
                  {u.breaker.state === 'half-open' &&
                    ` ${String(u.breaker.halfOpenInFlight)} probe(s) in flight.`}
                </p>
                <div className="pg-chart-grid">
                  <TimeSeriesChart
                    title={`${u.id}: failed attempts`}
                    description="Share of decided attempts that failed (aborted attempts excluded)"
                    points={upstreamFailurePoints(u.series.buckets)}
                    series={FAILURE_SERIES}
                    unit="%"
                  />
                  <TimeSeriesChart
                    title={`${u.id}: attempt latency`}
                    description="p50, p95 and p99 per attempt, in milliseconds"
                    points={latencyPoints(u.series.buckets)}
                    series={LATENCY_SERIES}
                    unit="ms"
                  />
                </div>
              </section>
            );
          })}
        </>
      )}
    </ScreenFrame>
  );
}
