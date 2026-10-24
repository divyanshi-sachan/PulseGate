import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ApiError } from './client.ts';

export const POLL_INTERVAL_MS = 5_000;
/** The stale banner appears after this many consecutive failed polls (plan §4). */
export const STALE_AFTER_MISSES = 2;

export interface Poll<T> {
  /** Last good response; kept while later polls fail, so the screen can show stale data with a banner. */
  data: T | undefined;
  /** Error of the latest poll, cleared by the next success. */
  error: ApiError | undefined;
  /** Wall-clock time of the last good response. */
  lastUpdated: number | undefined;
  /** Consecutive failed polls since the last success. */
  misses: number;
  stale: boolean;
  loading: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Fetches now, then continues the normal cadence from there. */
  refresh: () => void;
}

export interface PollOptions {
  intervalMs?: number;
  now?: () => number;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // Checked by name: a DOMException is not an Error subclass in every environment.
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'TimeoutError'
  ) {
    return new ApiError('unreachable', 'The admin API did not answer in time');
  }
  return new ApiError(
    'invalid-response',
    error instanceof Error ? error.message : 'Unexpected error',
  );
}

/**
 * Polls one admin API resource every 5 s (plan §6). Polls never overlap: the next one is scheduled when the previous
 * settles. Each poll is bounded by the interval, so a hung gateway counts as a miss instead of freezing the screen.
 * A 401 calls `onUnauthorized` (back to the token gate) and stops polling.
 */
export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: () => void,
  options: PollOptions = {},
): Poll<T> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [lastUpdated, setLastUpdated] = useState<number | undefined>();
  const [misses, setMisses] = useState(0);
  const [paused, setPausedState] = useState(false);
  const [tick, setTick] = useState(0);
  // The latest callbacks, read from inside the effect without re-running it.
  const loadLatest = useEffectEvent(load);
  const unauthorized = useEffectEvent(onUnauthorized);
  const stamp = useEffectEvent(now);
  const pausedRef = useRef(false);

  useEffect(() => {
    // `cancelled`: unmounted or superseded, so nothing may update. A poll that outlives the interval is aborted
    // through the same controller, but counts as a miss.
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      controller.abort(new DOMException('The admin API did not answer in time', 'TimeoutError'));
    }, intervalMs);
    const run = async () => {
      try {
        const result = await loadLatest(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setMisses(0);
        setLastUpdated(stamp());
      } catch (caught) {
        if (cancelled) return;
        const apiError = asApiError(controller.signal.aborted ? controller.signal.reason : caught);
        if (apiError.kind === 'unauthorized') {
          unauthorized();
          return;
        }
        setError(apiError);
        setMisses((m) => m + 1);
      }
      clearTimeout(deadline);
      // While paused the schedule simply stops; resuming or "Refresh now" starts it again.
      timer = setTimeout(() => {
        if (!pausedRef.current) setTick((t) => t + 1);
      }, intervalMs);
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(deadline);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [tick, intervalMs]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
    // Resuming fetches at once instead of waiting for the next interval.
    if (!next) setTick((t) => t + 1);
  }, []);

  return {
    data,
    error,
    lastUpdated,
    misses,
    stale: data !== undefined && misses >= STALE_AFTER_MISSES,
    loading: data === undefined && error === undefined,
    paused,
    setPaused,
    refresh,
  };
}
