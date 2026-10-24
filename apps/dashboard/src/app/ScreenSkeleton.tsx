/** Placeholder while a screen's code or first data loads; announced once to screen readers. */
export function ScreenSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="pg-visually-hidden">Loading…</span>
      <div className="pg-kpis" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pg-card pg-kpi">
            <span className="pg-skeleton pg-skeleton--label" />
            <span className="pg-skeleton pg-skeleton--value" />
          </div>
        ))}
      </div>
    </div>
  );
}
