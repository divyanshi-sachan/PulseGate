import type { ChartPoint, SeriesDef, Unit } from '../data/chart-data.ts';
import { formatClock } from '../data/format.ts';
import { formatValue } from './units.ts';

/** The chart's data as a table: visually hidden, read by screen readers and asserted by tests (plan §4). */
export function ChartTable({
  caption,
  points,
  series,
  unit,
  timeZone,
}: {
  caption: string;
  points: readonly ChartPoint[];
  series: readonly SeriesDef[];
  unit: Unit;
  timeZone?: string | undefined;
}) {
  return (
    <table className="pg-visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
          <th scope="col">Notes</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.t}>
            <th scope="row">{formatClock(point.t, timeZone)}</th>
            {series.map((s) => {
              const value = point[s.key];
              return (
                <td key={s.key}>{formatValue(typeof value === 'number' ? value : null, unit)}</td>
              );
            })}
            <td>{point.notes.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
