/**
 * Display formatting for every number on the dashboard. Pure functions, unit-tested; `null` (no denominator, no
 * observations) is always shown as an em dash, never as 0 (plan §2.3).
 */
export const MISSING = '—';

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatCount(value: number | null): string {
  return value === null ? MISSING : integer.format(value);
}

/** A ratio in [0, 1] as a percentage: one decimal below 10 %, none above, and never rounded to a false 0 % or 100 %. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return MISSING;
  const percent = ratio * 100;
  if (percent === 0 || percent === 100) return `${String(percent)} %`;
  if (percent < 0.1) return '< 0.1 %';
  if (percent > 99.9) return '> 99.9 %';
  const digits = percent < 10 || percent > 90 ? 1 : 0;
  return `${percent.toFixed(digits)} %`;
}

export function formatRps(value: number | null): string {
  if (value === null) return MISSING;
  if (value === 0) return '0 req/s';
  if (value < 0.1) return '< 0.1 req/s';
  return `${value < 10 ? value.toFixed(1) : integer.format(value)} req/s`;
}

export function formatMs(value: number | null): string {
  if (value === null) return MISSING;
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  if (value < 10_000) return `${integer.format(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

/** Retries per request that reached the upstream (ADR-0039): can exceed 1, so never a percentage. */
export function formatRetryRate(value: number | null): string {
  if (value === null) return MISSING;
  return `${value.toFixed(2)} / req`;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Wall-clock time of day (HH:MM:SS) in the browser's time zone. */
export function formatClock(epochMs: number, timeZone?: string): string {
  return timeZone === undefined
    ? clock.format(epochMs)
    : new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone,
      }).format(epochMs);
}
