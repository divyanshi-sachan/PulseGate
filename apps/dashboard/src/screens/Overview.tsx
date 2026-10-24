import { useCallback } from 'react';
import { usePoll } from '../api/use-poll.ts';
import { confidenceNote, Kpi } from '../app/Kpi.tsx';
import { EmptyState, ScreenFrame } from '../app/ScreenFrame.tsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.tsx';
import {
  ERROR_SERIES,
  isQuiet,
  LATENCY_SERIES,
  latencyPoints,
  routeErrorPoints,
  routeRps,
} from '../data/chart-data.ts';
import { formatCount, formatMs, formatPercent, formatRps } from '../data/format.ts';
import type { ScreenProps } from './types.ts';

const RPS_SERIES = [{ key: 'rps', label: 'Requests', className: 'pg-series--primary' }] as const;

/** Overview (plan §6): window KPIs and the total's latency, throughput and error trends. */
export default function Overview({ api, onUnauthorized }: ScreenProps) {
  const load = useCallback((signal: AbortSignal) => api.stats(signal), [api]);
  const poll = usePoll(load, onUnauthorized);
  return (
    <ScreenFrame title="Overview" poll={poll} envelope={(d) => d}>
      {(stats) => {
        const { window: w, buckets } = stats.total;
        return (
          <>
            <dl className="pg-kpis">
              <Kpi
                label="Requests"
                value={formatCount(w.counters.requests)}
                testId="kpi-requests"
              />
              <Kpi label="Throughput" value={formatRps(w.rates.rps)} testId="kpi-rps" />
              <Kpi
                label="Success rate"
                value={formatPercent(w.rates.successRate)}
                testId="kpi-success-rate"
              />
              <Kpi
                label="Server error rate"
                value={formatPercent(w.rates.errorRate)}
                testId="kpi-error-rate"
              />
              <Kpi
                label="p95 latency"
                value={formatMs(w.latency.p95.value)}
                note={confidenceNote(w.latency.p95)}
                testId="kpi-p95"
              />
              <Kpi
                label="p99 latency"
                value={formatMs(w.latency.p99.value)}
                note={confidenceNote(w.latency.p99)}
                testId="kpi-p99"
              />
            </dl>
            {isQuiet(stats.total) ? (
              <EmptyState title="No traffic in the last 5 minutes">
                Send requests through the gateway&apos;s public port (8080 by default); they appear
                here within 5 seconds.
              </EmptyState>
            ) : (
              <div className="pg-chart-grid">
                <TimeSeriesChart
                  title="Latency"
                  description="p50, p95 and p99 per 10-second interval, in milliseconds"
                  points={latencyPoints(buckets)}
                  series={LATENCY_SERIES}
                  unit="ms"
                />
                <TimeSeriesChart
                  title="Throughput"
                  description="Completed requests per second"
                  points={routeRps(buckets)}
                  series={RPS_SERIES}
                  unit="req/s"
                />
                <TimeSeriesChart
                  title="Error rate"
                  description="Share of completed requests answered with 5xx and 4xx"
                  points={routeErrorPoints(buckets)}
                  series={ERROR_SERIES}
                  unit="%"
                />
              </div>
            )}
          </>
        );
      }}
    </ScreenFrame>
  );
}
