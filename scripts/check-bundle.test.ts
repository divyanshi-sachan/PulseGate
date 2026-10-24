import { describe, expect, it } from 'vitest';
import {
  evaluate,
  initialFiles,
  INITIAL_BUDGET,
  inlineViolations,
  TOTAL_BUDGET,
  type Manifest,
} from './check-bundle.ts';

const manifest: Manifest = {
  'index.html': {
    file: 'assets/index.js',
    isEntry: true,
    imports: ['_vendor.js'],
    dynamicImports: ['src/screens/Overview.tsx'],
  },
  '_vendor.js': { file: 'assets/vendor.js', imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared.js' },
  'src/screens/Overview.tsx': { file: 'assets/Overview.js', imports: ['_charts.js'] },
  '_charts.js': { file: 'assets/charts.js', imports: ['_shared.js'] },
};

const CLEAN_HTML =
  '<!doctype html><html><head><script type="module" crossorigin src="/admin/ui/assets/index.js"></script>' +
  '<link rel="stylesheet" href="/admin/ui/assets/index.css"></head><body><div id="root"></div></body></html>';

describe('bundle budget (plan §3)', () => {
  it('counts the entry and its static imports transitively, never dynamic imports', () => {
    expect([...initialFiles(manifest)].sort()).toEqual([
      'assets/index.js',
      'assets/shared.js',
      'assets/vendor.js',
    ]);
  });

  it('passes within both budgets and reports per-chunk rows', () => {
    const sizes = new Map([
      ['assets/index.js', 10_000],
      ['assets/vendor.js', 60_000],
      ['assets/shared.js', 5_000],
      ['assets/Overview.js', 2_000],
      ['assets/charts.js', 100_000],
    ]);
    const report = evaluate(manifest, sizes, CLEAN_HTML);
    expect(report.failures).toEqual([]);
    expect(report.initialBytes).toBe(75_000);
    expect(report.totalBytes).toBe(177_000);
    expect(report.rows[0]).toEqual({
      file: 'assets/charts.js',
      gzipBytes: 100_000,
      initial: false,
    });
  });

  it('fails when the initial JS exceeds 120 KB', () => {
    const sizes = new Map([
      ['assets/index.js', INITIAL_BUDGET],
      ['assets/vendor.js', 1],
      ['assets/shared.js', 0],
    ]);
    expect(evaluate(manifest, sizes, CLEAN_HTML).failures).toEqual([
      'initial JS 120.0 KB exceeds the 120.0 KB budget',
    ]);
  });

  it('fails when lazy chunks push the total over 260 KB', () => {
    const sizes = new Map([
      ['assets/index.js', 1000],
      ['assets/vendor.js', 1000],
      ['assets/shared.js', 1000],
      ['assets/charts.js', TOTAL_BUDGET],
    ]);
    const { failures } = evaluate(manifest, sizes, CLEAN_HTML);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^total JS .* exceeds the 260.0 KB budget$/);
  });

  it('fails without an entry, or when an entry file is missing', () => {
    expect(evaluate({}, new Map(), CLEAN_HTML).failures).toContain('manifest has no entry chunk');
    expect(evaluate(manifest, new Map(), CLEAN_HTML).failures).toContain(
      'entry file assets/index.js is missing',
    );
  });
});

describe('inline code the CSP would block (ADR-0040)', () => {
  it('accepts external scripts and stylesheets', () => {
    expect(inlineViolations(CLEAN_HTML)).toEqual([]);
  });

  it.each([
    ['<script>window.x = 1</script>', 'index.html has an inline <script>'],
    ['<script type="module">import "/a.js"</script>', 'index.html has an inline <script>'],
    ['<script src="/a.js">alert(1)</script>', 'index.html has an inline <script>'],
    ['<style>body{}</style>', 'index.html has an inline <style>'],
    ['<div style="color:red"></div>', 'index.html has a style attribute'],
    ['<body onload="init()"></body>', 'index.html has an inline event handler'],
  ])('rejects %s', (html, problem) => {
    expect(inlineViolations(html)).toContain(problem);
  });
});
