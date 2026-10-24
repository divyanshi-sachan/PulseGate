/**
 * Dashboard bundle budget (plan §3, ADR-0037): run after `vite build`.
 * - Initial JS = the entry chunk + everything it imports statically, gzip -9: <= 120 KB.
 * - Total JS = every emitted .js file, gzip -9: <= 260 KB.
 * Also fails if the built index.html has inline scripts, inline event handlers or style attributes, which the
 * admin UI's CSP would block (ADR-0040). Prints a per-chunk table either way.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, gzipSync } from 'node:zlib';

export const INITIAL_BUDGET = 120 * 1024;
export const TOTAL_BUDGET = 260 * 1024;

export interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
export type Manifest = Record<string, ManifestChunk>;

/** Files loaded before anything else: each entry plus its static imports, transitively (dynamic imports excluded). */
export function initialFiles(manifest: Manifest): Set<string> {
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (chunk === undefined || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry === true) visit(key);
  return files;
}

export interface BudgetReport {
  rows: { file: string; gzipBytes: number; initial: boolean }[];
  initialBytes: number;
  totalBytes: number;
  failures: string[];
}

export function evaluate(
  manifest: Manifest,
  jsSizes: ReadonlyMap<string, number>,
  indexHtml: string,
): BudgetReport {
  const initial = initialFiles(manifest);
  const rows = [...jsSizes]
    .map(([file, gzipBytes]) => ({ file, gzipBytes, initial: initial.has(file) }))
    .sort((a, b) => b.gzipBytes - a.gzipBytes);
  const initialBytes = rows.filter((r) => r.initial).reduce((n, r) => n + r.gzipBytes, 0);
  const totalBytes = rows.reduce((n, r) => n + r.gzipBytes, 0);
  const failures: string[] = [];
  if (initial.size === 0) failures.push('manifest has no entry chunk');
  for (const file of initial) {
    if (file.endsWith('.js') && !jsSizes.has(file)) failures.push(`entry file ${file} is missing`);
  }
  if (initialBytes > INITIAL_BUDGET) {
    failures.push(`initial JS ${kb(initialBytes)} exceeds the ${kb(INITIAL_BUDGET)} budget`);
  }
  if (totalBytes > TOTAL_BUDGET) {
    failures.push(`total JS ${kb(totalBytes)} exceeds the ${kb(TOTAL_BUDGET)} budget`);
  }
  failures.push(...inlineViolations(indexHtml));
  return { rows, initialBytes, totalBytes, failures };
}

/** Inline code the CSP (`script-src 'self'; style-src 'self'`) would block. */
export function inlineViolations(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    if (!/\bsrc\s*=/.test(attributes) || (match[2] ?? '').trim() !== '') {
      problems.push('index.html has an inline <script>');
    }
  }
  if (/<style\b/i.test(html)) problems.push('index.html has an inline <style>');
  if (/\sstyle\s*=/i.test(html)) problems.push('index.html has a style attribute');
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('index.html has an inline event handler');
  return problems;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function main(): Promise<void> {
  const dist = process.argv[2] ?? 'apps/dashboard/dist';
  const manifest = JSON.parse(
    await readFile(join(dist, '.vite', 'manifest.json'), 'utf8'),
  ) as Manifest;
  const sizes = new Map<string, number>();
  for (const path of await listFiles(dist)) {
    if (!path.endsWith('.js')) continue;
    const gz = gzipSync(await readFile(path), { level: constants.Z_BEST_COMPRESSION });
    sizes.set(relative(dist, path), gz.length);
  }
  const report = evaluate(manifest, sizes, await readFile(join(dist, 'index.html'), 'utf8'));

  const width = Math.max(10, ...report.rows.map((r) => r.file.length));
  console.log(`${'chunk'.padEnd(width)}  gzip -9    load`);
  for (const row of report.rows) {
    console.log(
      `${row.file.padEnd(width)}  ${kb(row.gzipBytes).padStart(9)}  ${row.initial ? 'initial' : 'lazy'}`,
    );
  }
  console.log(
    `\ninitial ${kb(report.initialBytes)} / ${kb(INITIAL_BUDGET)}   total ${kb(report.totalBytes)} / ${kb(TOTAL_BUDGET)}`,
  );
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
  }
  console.log('Bundle budget OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
