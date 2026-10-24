import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCount,
  formatMs,
  formatPercent,
  formatRetryRate,
  formatRps,
  MISSING,
} from './format.ts';

describe('formatting (plan §4: units on every number, null never shown as 0)', () => {
  it('shows a missing value as an em dash everywhere', () => {
    for (const format of [formatCount, formatPercent, formatRps, formatMs, formatRetryRate]) {
      expect(format(null)).toBe(MISSING);
    }
  });

  it('formats counts with grouping', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('never rounds a ratio to a false 0 % or 100 %', () => {
    expect(formatPercent(0)).toBe('0 %');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(0.0004)).toBe('< 0.1 %');
    expect(formatPercent(0.9996)).toBe('> 99.9 %');
    expect(formatPercent(0.0123)).toBe('1.2 %');
    expect(formatPercent(0.4)).toBe('40 %');
    expect(formatPercent(2 / 3)).toBe('67 %');
    expect(formatPercent(0.955)).toBe('95.5 %');
  });

  it('formats throughput in req/s', () => {
    expect(formatRps(0)).toBe('0 req/s');
    expect(formatRps(0.03)).toBe('< 0.1 req/s');
    expect(formatRps(3.14159)).toBe('3.1 req/s');
    expect(formatRps(1234.4)).toBe('1,234 req/s');
  });

  it('formats latency in ms, switching to s above 10 s', () => {
    expect(formatMs(0.123)).toBe('0.12 ms');
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatMs(812.6)).toBe('813 ms');
    expect(formatMs(12_500)).toBe('12.5 s');
  });

  it('formats the retry rate per request, not as a percentage (it can exceed 1)', () => {
    expect(formatRetryRate(2)).toBe('2.00 / req');
    expect(formatRetryRate(0.25)).toBe('0.25 / req');
  });

  it('formats clock times as HH:MM:SS', () => {
    expect(formatClock(Date.UTC(2026, 9, 24, 13, 5, 9), 'UTC')).toBe('13:05:09');
  });
});

describe('bytes and durations', () => {
  it('formats binary sizes', async () => {
    const { formatBytes } = await import('./format.ts');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(67_108_864)).toBe('64 MiB');
  });

  it('formats elapsed time', async () => {
    const { formatAgo } = await import('./format.ts');
    expect(formatAgo(42_400)).toBe('42 s');
    expect(formatAgo(240_000)).toBe('4 min');
  });
});
