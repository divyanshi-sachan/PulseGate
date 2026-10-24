import type { Percentile } from '@pulsegate/admin-contract';
import { formatCount } from '../data/format.ts';

export function Kpi({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  testId?: string;
}) {
  return (
    <div className="pg-card pg-kpi">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
      {note !== undefined && <span className="pg-kpi__note">{note}</span>}
    </div>
  );
}

/** How much to trust a percentile (ADR-0038): no note when adequate; label and n otherwise. */
export function confidenceNote(p: Percentile): string | undefined {
  if (p.value === null || p.confidence === 'adequate') return undefined;
  return `${p.confidence} confidence, n=${formatCount(p.effectiveSamples)}`;
}
