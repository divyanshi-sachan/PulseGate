import type { Unit } from '../data/chart-data.ts';
import { formatCount, formatMs, formatPercent, formatRps } from '../data/format.ts';

/** Full value with unit, for tooltips and tables. Percent points arrive as 0..100. */
export function formatValue(value: number | null, unit: Unit): string {
  switch (unit) {
    case 'ms':
      return formatMs(value);
    case 'req/s':
      return formatRps(value);
    case '%':
      return formatPercent(value === null ? null : value / 100);
    case 'count':
      return formatCount(value);
  }
}

/** Compact axis tick with unit. */
export function formatTick(value: number, unit: Unit): string {
  switch (unit) {
    case 'ms':
      return value >= 10_000 ? `${String(value / 1000)} s` : `${String(value)} ms`;
    case 'req/s':
      return `${String(value)}/s`;
    case '%':
      return `${String(value)}%`;
    case 'count':
      return String(value);
  }
}
