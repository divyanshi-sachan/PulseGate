import { useId } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartPoint, SeriesDef, Unit } from '../data/chart-data.ts';
import { formatClock } from '../data/format.ts';
import { ChartTable } from './ChartTable.tsx';
import { formatTick, formatValue } from './units.ts';
import './charts.css';

export interface TimeSeriesChartProps {
  title: string;
  description: string;
  points: readonly ChartPoint[];
  series: readonly SeriesDef[];
  unit: Unit;
  height?: number;
  /** For deterministic tests; defaults to the browser's zone. */
  timeZone?: string;
}

function ChartTooltip({
  active,
  label,
  points,
  series,
  unit,
  timeZone,
}: {
  active: boolean | undefined;
  label: unknown;
  points: readonly ChartPoint[];
  series: readonly SeriesDef[];
  unit: Unit;
  timeZone?: string | undefined;
}) {
  if (active !== true || typeof label !== 'number') return null;
  const point = points.find((p) => p.t === label);
  if (point === undefined) return null;
  return (
    <div className="pg-tooltip">
      <div className="pg-tooltip__time">
        {formatClock(label, timeZone)} – {formatClock(label + 10_000, timeZone)}
      </div>
      <ul className="pg-tooltip__values">
        {series.map((s) => {
          const value = point[s.key];
          return (
            <li key={s.key}>
              <span className={`pg-swatch ${s.className}`} aria-hidden="true" />
              <span className="pg-tooltip__label">{s.label}</span>
              <span className="pg-tooltip__value">
                {formatValue(typeof value === 'number' ? value : null, unit)}
              </span>
            </li>
          );
        })}
      </ul>
      {point.notes.length > 0 && (
        <ul className="pg-tooltip__notes">
          {point.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {series.every((s) => typeof point[s.key] !== 'number') && (
        <p className="pg-tooltip__notes">No data in this interval</p>
      )}
    </div>
  );
}

/** A dot only where a value has no neighbour (a single bucket, or a point between gaps), so it stays visible. */
function isolatedDot(points: readonly ChartPoint[], key: string, className: string) {
  const has = (i: number) => typeof points[i]?.[key] === 'number';
  return function Dot(props: { cx?: number; cy?: number; index?: number }) {
    const { cx, cy, index } = props;
    if (cx === undefined || cy === undefined || index === undefined)
      return <g key={`dot-${String(index)}`} />;
    if (!has(index) || has(index - 1) || has(index + 1)) return <g key={`dot-${String(index)}`} />;
    return (
      <circle
        key={`dot-${String(index)}`}
        className={`pg-chart__dot ${className}`}
        cx={cx}
        cy={cy}
        r={3}
      />
    );
  };
}

/**
 * Line chart over the window's 10 s buckets (plan §4): linear segments, gaps for missing data, no animation, units on
 * the axis and in the tooltip, plus a title, a description and a table alternative for assistive technology.
 */
export function TimeSeriesChart({
  title,
  description,
  points,
  series,
  unit,
  height = 220,
  timeZone,
}: TimeSeriesChartProps) {
  const id = useId();
  return (
    <figure
      className="pg-card pg-chart"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
    >
      <figcaption className="pg-chart__header">
        <div>
          <h3 id={`${id}-title`} className="pg-chart__title">
            {title}
          </h3>
          <p id={`${id}-desc`} className="pg-hint">
            {description}
          </p>
        </div>
        {series.length > 1 && (
          <ul className="pg-legend" aria-hidden="true">
            {series.map((s) => (
              <li key={s.key}>
                <span className={`pg-swatch pg-swatch--line ${s.className}`} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      <div className="pg-chart__plot" aria-hidden="true">
        <ResponsiveContainer width="100%" height={height} minWidth={0}>
          <LineChart data={[...points]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid className="pg-chart__grid" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => formatClock(t, timeZone).slice(0, 5)}
              minTickGap={40}
              tickLine={false}
              className="pg-chart__axis"
            />
            <YAxis
              width={64}
              domain={unit === '%' ? [0, 100] : [0, 'auto']}
              tickFormatter={(v: number) => formatTick(v, unit)}
              tickLine={false}
              axisLine={false}
              className="pg-chart__axis"
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ className: 'pg-chart__cursor' }}
              content={({ active, label }) => (
                <ChartTooltip
                  active={active}
                  label={label}
                  points={points}
                  series={series}
                  unit={unit}
                  timeZone={timeZone}
                />
              )}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                className={s.className}
                type="linear"
                connectNulls={false}
                isAnimationActive={false}
                strokeWidth={1.75}
                dot={isolatedDot(points, s.key, s.className)}
                activeDot={{ r: 3, className: `pg-chart__active-dot ${s.className}` }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartTable caption={title} points={points} series={series} unit={unit} timeZone={timeZone} />
    </figure>
  );
}
