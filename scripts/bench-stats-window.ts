/**
 * Memory benchmark for the rolling stats window (plan §2.2). Run with:
 *   node --expose-gc --conditions=@pulsegate/source scripts/bench-stats-window.ts
 * For each configuration it fills every bucket and reservoir, measures heapUsed + arrayBuffers after GC,
 * and checks the result against the documented formula; then it records 1,000,000 more requests and
 * checks that memory does not grow. Exits non-zero on any breach.
 *
 * Each configuration runs in its own child process: ArrayBuffer backing stores are released lazily
 * after GC, so measuring several windows in one process lets an earlier window's memory leak into the
 * next measurement (it undercounted by ~20 % before this was isolated).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StatsWindow, statsWindowBound } from '@pulsegate/observability';

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.error('Run with --expose-gc');
  process.exit(2);
}

function measured(): number {
  gc?.();
  gc?.();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

const MiB = 1024 * 1024;

interface Result {
  routes: number;
  upstreams: number;
  bound: number;
  filled: number;
  after: number;
  payload: number;
}

function runOne(routeCount: number, upstreamCount: number): Result {
  const routes = Array.from({ length: routeCount }, (_, i) => `route-${String(i)}`);
  const upstreams = Array.from({ length: upstreamCount }, (_, i) => `up-${String(i)}`);
  let now = 1_800_000_000_000;
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const before = measured();
  const window = new StatsWindow({
    routes,
    upstreams,
    wallClock: () => 1_800_000_000_000,
    monotonic: () => now,
    random,
  });
  // Fill every bucket of every series past the reservoir size (600 observations per bucket).
  for (let bucket = 0; bucket < 30; bucket++) {
    for (const routeId of routes) {
      for (let i = 0; i < 600; i++)
        window.recordRequest({ routeId, statusCode: 200, code: undefined, latencyMs: i });
    }
    for (const upstreamId of upstreams) {
      for (let i = 0; i < 600; i++) {
        window.recordAttempt({
          routeId: routes[0] ?? 'x',
          upstreamId,
          outcome: 'success',
          latencyMs: i,
        });
      }
    }
    now += 10_000;
  }
  const filled = measured() - before;
  // A further 1,000,000 requests across all buckets must not grow memory.
  for (let i = 0; i < 1_000_000; i++) {
    if (i % 5000 === 0) now += 1000;
    window.recordRequest({
      routeId: routes[i % routeCount],
      statusCode: 200,
      code: undefined,
      latencyMs: i % 900,
    });
  }
  const after = measured() - before;
  return {
    routes: routeCount,
    upstreams: upstreamCount,
    bound: statsWindowBound(routeCount, upstreamCount),
    filled,
    after,
    payload: window.payloadBytes(),
  };
}

if (process.argv[2] === 'single') {
  console.log(JSON.stringify(runOne(Number(process.argv[3]), Number(process.argv[4]))));
  process.exit(0);
}

const configs: [number, number][] = [
  [10, 5],
  [50, 20],
  [200, 100],
];
let failed = false;
for (const [routeCount, upstreamCount] of configs) {
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--conditions=@pulsegate/source',
      fileURLToPath(import.meta.url),
      'single',
      String(routeCount),
      String(upstreamCount),
    ],
    { encoding: 'utf8' },
  );
  if (child.status !== 0) {
    failed = true;
    console.log(`${String(routeCount)}/${String(upstreamCount)}: child failed\n${child.stderr}`);
    continue;
  }
  const r = JSON.parse(child.stdout) as Result;
  const growth = r.after - r.filled;
  // Within the formula + 15 % (object overhead), not below it (the arrays are really there), no growth.
  const ok =
    r.filled <= r.bound * 1.15 &&
    r.filled >= r.bound * 0.95 &&
    growth <= r.bound * 0.02 &&
    r.payload === r.bound;
  if (!ok) failed = true;
  console.log(
    `${String(r.routes).padStart(3)} routes / ${String(r.upstreams).padStart(3)} upstreams: ` +
      `formula ${(r.bound / MiB).toFixed(2)} MiB, measured ${(r.filled / MiB).toFixed(2)} MiB ` +
      `(${((r.filled / r.bound) * 100).toFixed(1)} %), after +1M requests ${(r.after / MiB).toFixed(2)} MiB ` +
      `(growth ${(growth / 1024).toFixed(1)} KiB) ${ok ? 'OK' : 'FAIL'}`,
  );
}

process.exit(failed ? 1 : 0);
