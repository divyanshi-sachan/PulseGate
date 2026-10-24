import { useCallback, useId } from 'react';
import { usePoll } from '../api/use-poll.ts';
import { Kpi } from '../app/Kpi.tsx';
import { EmptyState, ScreenFrame } from '../app/ScreenFrame.tsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.tsx';
import { cacheHitPoints } from '../data/chart-data.ts';
import { formatBytes, formatCount, formatPercent } from '../data/format.ts';
import type { ScreenProps } from './types.ts';

const HIT_SERIES = [
  { key: 'hitRatio', label: 'Hit ratio', className: 'pg-series--success' },
] as const;

function Usage({
  label,
  value,
  max,
  format,
  testId,
}: {
  label: string;
  value: number;
  max: number;
  format: (n: number) => string;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="pg-meter">
      <label htmlFor={id} className="pg-label">
        {label}
      </label>
      <meter id={id} min={0} max={max} value={value} high={max * 0.9} optimum={0} />
      <span className="pg-hint" data-testid={testId}>
        {format(value)} of {format(max)} ({formatPercent(max === 0 ? null : value / max)})
      </span>
    </div>
  );
}

/** Cache (plan §6): memory against its bounds, evictions, and per-route hit ratio, bypass share and store outcomes. */
export default function Cache({ api, onUnauthorized }: ScreenProps) {
  const load = useCallback((signal: AbortSignal) => api.cache(signal), [api]);
  const poll = usePoll(load, onUnauthorized);
  return (
    <ScreenFrame title="Cache" poll={poll} envelope={(d) => d}>
      {(data) => (
        <>
          <section className="pg-card pg-panel" aria-labelledby="cache-memory">
            <h2 id="cache-memory" className="pg-section-title">
              Memory
            </h2>
            <div className="pg-chart-grid">
              <Usage
                label="Entries"
                value={data.usage.entries}
                max={data.limits.maxEntries}
                format={formatCount}
                testId="cache-entries"
              />
              <Usage
                label="Size"
                value={data.usage.bytes}
                max={data.limits.maxBytes}
                format={formatBytes}
                testId="cache-bytes"
              />
            </div>
            <p className="pg-hint">
              Evicted since start: {formatCount(data.evictions.lifetime.capacity)} for space,{' '}
              {formatCount(data.evictions.lifetime.expired)} expired.
            </p>
          </section>
          {data.routes.length === 0 ? (
            <EmptyState title="No route has caching enabled">
              Set cache.enabled and cache.ttlSeconds on a GET route.
            </EmptyState>
          ) : (
            data.routes.map((r) => {
              const { counters, rates } = r.series.window;
              return (
                <section key={r.id} className="pg-card pg-panel" aria-labelledby={`cache-${r.id}`}>
                  <div className="pg-panel__header">
                    <h2 id={`cache-${r.id}`} className="pg-section-title pg-mono">
                      {r.id}
                    </h2>
                    <span className="pg-subtle">
                      {String(r.ttlSeconds)} s TTL ·{' '}
                      {r.scope === 'shared' ? 'shared' : 'per client'}
                    </span>
                  </div>
                  <dl className="pg-kpis">
                    <Kpi
                      label="Hit ratio"
                      value={formatPercent(rates.cacheHitRatio)}
                      note={`${formatCount(counters.cache.hit)} of ${formatCount(counters.cache.hit + counters.cache.miss)} lookups`}
                      testId={`cache-hit-ratio-${r.id}`}
                    />
                    <Kpi
                      label="Bypassed"
                      value={formatPercent(rates.cacheBypassRate)}
                      note={`${formatCount(counters.cache.bypass)} requests skipped the cache`}
                      testId={`cache-bypass-rate-${r.id}`}
                    />
                    <Kpi
                      label="Misses stored"
                      value={formatPercent(rates.cacheStoreRate)}
                      note={`${formatCount(counters.store.notStorable)} not storable, ${formatCount(counters.store.tooLarge)} too large`}
                      testId={`cache-store-rate-${r.id}`}
                    />
                  </dl>
                  <TimeSeriesChart
                    title={`${r.id}: hit ratio`}
                    description="Hits among cache lookups per interval; bypasses are not lookups"
                    points={cacheHitPoints(r.series.buckets)}
                    series={HIT_SERIES}
                    unit="%"
                  />
                </section>
              );
            })
          )}
        </>
      )}
    </ScreenFrame>
  );
}
