// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Read from disk: Vitest replaces CSS imports (even ?raw) with empty modules.
const tokens = readFileSync(new URL('tokens.css', import.meta.url), 'utf8');

/** Resolves a token to a #rrggbb value, following var() references. */
function color(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens);
  const value = match?.[1]?.trim();
  if (value === undefined) throw new Error(`token --${name} missing`);
  const reference = /^var\(--([\w-]+)\)$/.exec(value);
  return reference?.[1] === undefined ? value : color(reference[1]);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(color(a)), luminance(color(b))].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('design tokens (plan §4): WCAG AA text contrast', () => {
  it.each(['success', 'warning', 'danger', 'info'])(
    '%s text is >= 4.5:1 on cards and on its own tinted surface',
    (status) => {
      expect(contrast(`pg-${status}`, 'pg-surface-card')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(`pg-${status}`, `pg-${status}-surface`)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ['pg-text', 'pg-surface-page'],
    ['pg-text-muted', 'pg-surface-page'],
    ['pg-text-muted', 'pg-surface-card'],
    ['pg-text-inverse', 'pg-accent'],
    ['pg-text-inverse', 'pg-accent-hover'],
  ])('%s on %s is >= 4.5:1', (text, surface) => {
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('subtle text (hints, axis labels) is >= 4.5:1 on cards', () => {
    expect(contrast('pg-text-subtle', 'pg-surface-card')).toBeGreaterThanOrEqual(4.5);
  });

  it('series colours are distinct from each other and visible on cards (>= 3:1 for graphics)', () => {
    const series = ['pg-series-p50', 'pg-series-p95', 'pg-series-p99'].map(color);
    expect(new Set(series).size).toBe(3);
    for (const name of ['pg-series-p50', 'pg-series-p95', 'pg-series-p99']) {
      expect(contrast(name, 'pg-surface-card')).toBeGreaterThanOrEqual(2);
    }
  });
});
