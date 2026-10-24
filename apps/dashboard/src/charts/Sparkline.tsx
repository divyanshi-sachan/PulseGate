import { sparklinePath } from '../data/chart-data.ts';
import './charts.css';

const WIDTH = 96;
const HEIGHT = 24;

/** Tiny trend line for table rows: plain SVG (no chart library), gaps for missing buckets, labelled for screen readers. */
export function Sparkline({
  values,
  label,
}: {
  values: readonly (number | null)[];
  label: string;
}) {
  return (
    <svg
      className="pg-sparkline"
      viewBox={`-2 -2 ${String(WIDTH + 4)} ${String(HEIGHT + 4)}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={label}
    >
      <path d={sparklinePath(values, WIDTH, HEIGHT)} />
    </svg>
  );
}
