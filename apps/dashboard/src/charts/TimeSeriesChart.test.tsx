import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LATENCY_SERIES, type ChartPoint } from '../data/chart-data.ts';
import { BreakerBadge } from './StatusBadge.tsx';
import { Sparkline } from './Sparkline.tsx';
import { TimeSeriesChart } from './TimeSeriesChart.tsx';

const T = Date.UTC(2026, 9, 24, 12, 0, 0);
const points: ChartPoint[] = [
  { t: T, notes: [], p50: 12.5, p95: 40, p99: 120 },
  { t: T + 10_000, notes: [], p50: null, p95: null, p99: null },
  {
    t: T + 20_000,
    notes: ['In progress: 4.0 s so far', 'p99 low confidence (n=12)'],
    p50: 11,
    p95: 30,
    p99: 95,
  },
];

describe('TimeSeriesChart (plan §4: accessible, units, gaps)', () => {
  it('is a figure named by its title and described by its description', () => {
    render(
      <TimeSeriesChart
        title="Latency"
        description="p50, p95 and p99 in ms"
        points={points}
        series={LATENCY_SERIES}
        unit="ms"
        timeZone="UTC"
      />,
    );
    const figure = screen.getByRole('figure', { name: 'Latency' });
    expect(figure.getAttribute('aria-describedby')).not.toBeNull();
    expect(screen.getByText('p50, p95 and p99 in ms')).toBeDefined();
  });

  it('has a table alternative with units, gaps as dashes and the notes', () => {
    render(
      <TimeSeriesChart
        title="Latency"
        description="d"
        points={points}
        series={LATENCY_SERIES}
        unit="ms"
        timeZone="UTC"
      />,
    );
    const rows = within(screen.getByRole('table', { name: 'Latency' })).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Timep50p95p99Notes',
      '12:00:0012.5 ms40.0 ms120 ms',
      '12:00:10———',
      '12:00:2011.0 ms30.0 ms95.0 msIn progress: 4.0 s so far; p99 low confidence (n=12)',
    ]);
  });

  it('formats percentages from percent points', () => {
    render(
      <TimeSeriesChart
        title="Hit ratio"
        description="d"
        points={[{ t: T, notes: [], hit: 80 }]}
        series={[{ key: 'hit', label: 'Hit ratio', className: 'pg-series--success' }]}
        unit="%"
        timeZone="UTC"
      />,
    );
    expect(
      within(screen.getByRole('table', { name: 'Hit ratio' })).getByText('80 %'),
    ).toBeDefined();
  });
});

describe('small displays', () => {
  it('labels a sparkline for screen readers', () => {
    render(<Sparkline values={[1, null, 3]} label="orders throughput trend" />);
    expect(screen.getByRole('img', { name: 'orders throughput trend' })).toBeDefined();
  });

  it.each([
    ['closed', 'Closed'],
    ['half-open', 'Half-open'],
    ['open', 'Open'],
  ] as const)('breaker %s is shown as text, not colour alone', (state, text) => {
    render(<BreakerBadge state={state} testId="b" />);
    expect(screen.getByTestId('b').textContent).toContain(text);
  });
});
