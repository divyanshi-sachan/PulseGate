import { GATEWAY_ERRORS } from '@pulsegate/shared';

/** Rolling window shape (ADR-0037 amendment: 30 × 10 s). */
export const WINDOW_SECONDS = 300;
export const BUCKET_SECONDS = 10;
export const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_SECONDS;
/** Latency reservoir per bucket and series (plan §2.1). */
export const RESERVOIR_SIZE = 512;
/** A percentile is "ok" only with at least this many samples beyond it (plan §2.1). */
export const CONFIDENCE_TAIL_MIN = 5;
export const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

/** Every `code` a counter can carry: the error registry plus the two non-registry outcomes. */
export const COUNTED_CODES = [...Object.keys(GATEWAY_ERRORS), 'CLIENT_ABORTED', 'other'] as const;
export type CountedCode = (typeof COUNTED_CODES)[number];
