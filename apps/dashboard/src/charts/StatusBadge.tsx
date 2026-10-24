import './charts.css';

export type BreakerState = 'closed' | 'open' | 'half-open';

const LABELS: Record<BreakerState, { text: string; tone: string; icon: string }> = {
  closed: { text: 'Closed', tone: 'success', icon: '●' },
  'half-open': { text: 'Half-open', tone: 'warning', icon: '◐' },
  open: { text: 'Open', tone: 'danger', icon: '○' },
};

/** Breaker state as text plus shape, never colour alone. */
export function BreakerBadge({ state, testId }: { state: BreakerState; testId?: string }) {
  const { text, tone, icon } = LABELS[state];
  return (
    <span className={`pg-badge pg-badge--${tone}`} data-testid={testId} data-state={state}>
      <span aria-hidden="true">{icon}</span> {text}
    </span>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: string;
}) {
  return <span className={`pg-badge pg-badge--${tone}`}>{children}</span>;
}
