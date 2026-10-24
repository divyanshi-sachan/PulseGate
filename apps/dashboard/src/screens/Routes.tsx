import type { RoutesResponse, StatsResponse } from '@pulsegate/admin-contract';
import { useCallback, useState } from 'react';
import { usePoll } from '../api/use-poll.ts';
import { confidenceNote } from '../app/Kpi.tsx';
import { EmptyState, ScreenFrame } from '../app/ScreenFrame.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.tsx';
import {
  LATENCY_SERIES,
  latencyPoints,
  routeRps,
  sortRows,
  type SortDirection,
} from '../data/chart-data.ts';
import {
  formatCount,
  formatMs,
  formatPercent,
  formatRetryRate,
  formatRps,
} from '../data/format.ts';
import type { ScreenProps } from './types.ts';

type Series = StatsResponse['routes'][number]['series'];
type Config = RoutesResponse['routes'][number];
interface Row {
  id: string;
  config: Config | undefined;
  series: Series;
}

const COLUMNS: {
  key: string;
  label: string;
  value: (row: Row) => number | string | null;
  format: (row: Row) => string;
}[] = [
  {
    key: 'requests',
    label: 'Requests',
    value: (r) => r.series.window.counters.requests,
    format: (r) => formatCount(r.series.window.counters.requests),
  },
  {
    key: 'rps',
    label: 'Throughput',
    value: (r) => r.series.window.rates.rps,
    format: (r) => formatRps(r.series.window.rates.rps),
  },
  {
    key: 'success',
    label: 'Success',
    value: (r) => r.series.window.rates.successRate,
    format: (r) => formatPercent(r.series.window.rates.successRate),
  },
  {
    key: 'errors',
    label: '5xx',
    value: (r) => r.series.window.rates.errorRate,
    format: (r) => formatPercent(r.series.window.rates.errorRate),
  },
  {
    key: 'p95',
    label: 'p95',
    value: (r) => r.series.window.latency.p95.value,
    format: (r) => formatMs(r.series.window.latency.p95.value),
  },
  {
    key: 'rejected',
    label: 'Rate limited',
    value: (r) => r.series.window.rates.rateLimitRejectionRate,
    format: (r) => formatPercent(r.series.window.rates.rateLimitRejectionRate),
  },
  {
    key: 'cache',
    label: 'Cache hits',
    value: (r) => r.series.window.rates.cacheHitRatio,
    format: (r) => formatPercent(r.series.window.rates.cacheHitRatio),
  },
];

const RPS_SERIES = [{ key: 'rps', label: 'Requests', className: 'pg-series--primary' }] as const;

function RouteDetail({ row }: { row: Row }) {
  const { config, series } = row;
  return (
    <section
      className="pg-card pg-panel"
      aria-labelledby="route-detail-title"
      data-testid="route-detail"
    >
      <div className="pg-panel__header">
        <h2 id="route-detail-title" className="pg-section-title">
          Route <span className="pg-mono">{row.id}</span>
        </h2>
      </div>
      {config !== undefined && (
        <dl className="pg-details">
          <div>
            <dt>Match</dt>
            <dd className="pg-mono">
              {config.methods.join(', ')} {config.pathPrefix}
            </dd>
          </div>
          <div>
            <dt>Upstream</dt>
            <dd className="pg-mono">
              {config.upstreamId}
              {config.stripPrefix ? ' (prefix stripped)' : ''}
            </dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd>{config.authRequired ? 'API key required' : 'Public'}</dd>
          </div>
          <div>
            <dt>Rate limit</dt>
            <dd>
              {formatCount(config.rateLimit.capacity)} burst,{' '}
              {String(config.rateLimit.refillRatePerSecond)}/s refill
            </dd>
          </div>
          <div>
            <dt>Timeouts</dt>
            <dd>
              {formatMs(config.timeoutMs)} total
              {config.attemptTimeoutMs === null
                ? ''
                : `, ${formatMs(config.attemptTimeoutMs)} per attempt`}
            </dd>
          </div>
          <div>
            <dt>Retries</dt>
            <dd>
              {config.retries.maxAttempts === 1
                ? 'Off'
                : `Up to ${String(config.retries.maxAttempts)} attempts on ${config.retries.retryableStatuses.join(', ')}`}
              {` · ${formatRetryRate(series.window.rates.retryRate)} now`}
            </dd>
          </div>
          <div>
            <dt>Cache</dt>
            <dd>
              {config.cache.enabled
                ? `${String(config.cache.ttlSeconds)} s TTL, ${config.cache.scope === 'shared' ? 'shared' : 'per client'}`
                : 'Off'}
            </dd>
          </div>
          <div>
            <dt>Forwarding</dt>
            <dd>
              Authorization {config.forwarding.authorization ? 'forwarded' : 'stripped'},
              X-Forwarded-Host {config.forwarding.forwardedHost ? 'on' : 'off'}
            </dd>
          </div>
        </dl>
      )}
      <div className="pg-chart-grid">
        <TimeSeriesChart
          title={`${row.id}: latency`}
          description="p50, p95 and p99 per 10-second interval, in milliseconds"
          points={latencyPoints(series.buckets)}
          series={LATENCY_SERIES}
          unit="ms"
        />
        <TimeSeriesChart
          title={`${row.id}: throughput`}
          description="Completed requests per second"
          points={routeRps(series.buckets)}
          series={RPS_SERIES}
          unit="req/s"
        />
      </div>
    </section>
  );
}

/** Routes (plan §6): sortable table with throughput sparklines, and a detail panel with configuration and trends. */
export default function Routes({ api, onUnauthorized }: ScreenProps) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [stats, routes] = await Promise.all([api.stats(signal), api.routes(signal)]);
      return { stats, routes };
    },
    [api],
  );
  const poll = usePoll(load, onUnauthorized);
  const [sort, setSort] = useState<{ key: string; direction: SortDirection }>({
    key: 'requests',
    direction: 'descending',
  });
  const [selected, setSelected] = useState<string | undefined>();

  return (
    <ScreenFrame title="Routes" poll={poll} envelope={(d) => d.stats}>
      {({ stats, routes }) => {
        const rows: Row[] = stats.routes.map((r) => ({
          id: r.id,
          series: r.series,
          config: routes.routes.find((c) => c.id === r.id),
        }));
        if (rows.length === 0)
          return (
            <EmptyState title="No routes configured">Add routes to the gateway config.</EmptyState>
          );
        const column = COLUMNS.find((c) => c.key === sort.key);
        const sorted = column === undefined ? rows : sortRows(rows, column.value, sort.direction);
        const current = rows.find((r) => r.id === selected) ?? sorted[0];
        return (
          <>
            <div className="pg-card pg-table-wrap">
              <table className="pg-table">
                <caption className="pg-visually-hidden">Routes over the last 5 minutes</caption>
                <thead>
                  <tr>
                    <th scope="col">Route</th>
                    <th scope="col">Trend</th>
                    {COLUMNS.map((c) => {
                      const active = sort.key === c.key;
                      return (
                        <th key={c.key} scope="col" aria-sort={active ? sort.direction : 'none'}>
                          <button
                            type="button"
                            className="pg-sort"
                            onClick={() => {
                              setSort({
                                key: c.key,
                                direction:
                                  active && sort.direction === 'descending'
                                    ? 'ascending'
                                    : 'descending',
                              });
                            }}
                          >
                            {c.label}
                            <span className="pg-sort__arrow" aria-hidden="true">
                              {active ? (sort.direction === 'descending' ? '↓' : '↑') : '↕'}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => {
                    const p95Note = confidenceNote(row.series.window.latency.p95);
                    return (
                      <tr
                        key={row.id}
                        data-testid={`route-row-${row.id}`}
                        aria-selected={current?.id === row.id}
                      >
                        <td>
                          <button
                            type="button"
                            className="pg-link-button pg-mono"
                            onClick={() => {
                              setSelected(row.id);
                            }}
                          >
                            {row.id}
                          </button>
                          {row.config !== undefined && (
                            <div className="pg-subtle pg-mono">{row.config.pathPrefix}</div>
                          )}
                        </td>
                        <td>
                          <Sparkline
                            values={row.series.buckets.map((b) => b.rates.rps)}
                            label={`${row.id} throughput trend, now ${formatRps(row.series.window.rates.rps)}`}
                          />
                        </td>
                        {COLUMNS.map((c) => (
                          <td key={c.key} data-testid={`route-${c.key}-${row.id}`}>
                            {c.format(row)}
                            {c.key === 'p95' && p95Note !== undefined && (
                              <div className="pg-subtle">{p95Note}</div>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {current !== undefined && <RouteDetail row={current} />}
          </>
        );
      }}
    </ScreenFrame>
  );
}
