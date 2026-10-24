/**
 * Environment metadata for a benchmark run (ADR-0046): hardware, OS, Docker and its limits, versions, git state and
 * the SHA-256 of every file that defines the workload. Written to <run-dir>/meta.json by scripts/bench.sh.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, type as osType, release, arch } from 'node:os';
import { join } from 'node:path';
import { loadConfigFile } from '../packages/config/src/index.ts';

const [dir, profile = 'quick'] = process.argv.slice(2);
if (dir === undefined) throw new Error('usage: node scripts/bench-meta.ts <run-dir> <profile>');

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

const workloadFiles = [
  'config/routes.bench.yaml',
  'config/routes.bench-redis.yaml',
  'docker-compose.yml',
  'docker-compose.distributed.yml',
  'docker-compose.bench.yml',
  'docker-compose.bench-redis.yml',
  'scripts/bench.sh',
  ...(await readdir('benchmarks/k6'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `benchmarks/k6/${f}`),
].sort();
const hashes: Record<string, string> = {};
for (const file of workloadFiles) hashes[file] = await sha256(file);

const dockerInfo = JSON.parse(run('docker', ['info', '--format', '{{json .}}']) || '{}') as Record<
  string,
  unknown
>;
/** First non-empty value: an empty string means "not available on this OS". */
function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.map((v) => (v ?? '').trim()).find((v) => v !== '') ?? '';
}
const cpuModel = firstNonEmpty(
  run('sysctl', ['-n', 'machdep.cpu.brand_string']),
  run('sh', ['-c', "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"]),
  cpus()[0]?.model,
);

// The Redis limiter settings in force for K8, resolved from the pinned config (defaults included), so each report states
// the timeout it measured rather than assuming one (ADR-0048).
const redisConfig = (await loadConfigFile('config/routes.bench-redis.yaml')).rateLimit;

const meta = {
  profile,
  /** Shared CI runners: numbers are not comparable and never committed (ADR-0046). */
  ci: process.env['CI'] !== undefined,
  startedAt: new Date().toISOString(),
  host: {
    cpuModel,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    os: `${osType()} ${release()} (${arch()})`,
  },
  docker: {
    serverVersion: dockerInfo['ServerVersion'] ?? '',
    operatingSystem: dockerInfo['OperatingSystem'] ?? '',
    cpus: dockerInfo['NCPU'] ?? null,
    memoryBytes: dockerInfo['MemTotal'] ?? null,
    composeVersion: run('docker', ['compose', 'version', '--short']),
  },
  limits: {
    gateway: { cpus: 2, memory: '512m' },
    mocks: { cpus: 1, memory: '256m' },
    redis: { cpus: 1, memory: '256m' },
    k6: { cpus: 2, memory: '1g' },
  },
  versions: {
    node: process.version,
    k6Image:
      'grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34',
    nodeImage: 'node:26.4.0-slim',
  },
  git: {
    commit: run('git', ['rev-parse', 'HEAD']),
    dirtyFiles: run('git', ['status', '--porcelain'])
      .split('\n')
      .filter((l) => l.trim() !== '').length,
  },
  workloadHashes: hashes,
  redisLimiter: {
    commandTimeoutMs: redisConfig.redis.commandTimeoutMs,
    failurePolicy: redisConfig.mode === 'redis' ? redisConfig.redisFailurePolicy : null,
  },
};
await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
