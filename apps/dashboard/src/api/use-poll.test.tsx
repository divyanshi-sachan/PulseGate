import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.ts';
import { STALE_AFTER_MISSES, usePoll } from './use-poll.ts';

/** A loader whose answers are queued by the test: a value, an error, or "hang". */
function scripted() {
  const queue: (number | Error | 'hang')[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const load = vi.fn((signal: AbortSignal) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const next = queue.shift() ?? 0;
    return new Promise<number>((resolve, reject) => {
      const done = () => {
        inFlight--;
      };
      signal.addEventListener('abort', () => {
        done();
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      });
      if (next === 'hang') return;
      queueMicrotask(() => {
        done();
        if (next instanceof Error) reject(next);
        else resolve(next);
      });
    });
  });
  return { queue, load, maxInFlight: () => maxInFlight };
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('usePoll (plan §6: 5 s polling, pause/resume, refresh now, stale after 2 misses)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads at once, then every interval, never overlapping', async () => {
    const s = scripted();
    s.queue.push(1, 2, 3);
    const { result } = renderHook(() =>
      usePoll(s.load, vi.fn(), { intervalMs: 5_000, now: () => 42 }),
    );
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current).toMatchObject({
      data: 1,
      lastUpdated: 42,
      loading: false,
      stale: false,
    });
    await wait(4_999);
    expect(s.load).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(result.current.data).toBe(2);
    await wait(5_000);
    expect(result.current.data).toBe(3);
    expect(s.maxInFlight()).toBe(1);
  });

  it(`keeps the last data and turns stale after ${String(STALE_AFTER_MISSES)} missed polls`, async () => {
    const s = scripted();
    s.queue.push(7, new ApiError('unreachable', 'down'), new ApiError('unreachable', 'down'), 8);
    const { result } = renderHook(() => usePoll(s.load, vi.fn(), { intervalMs: 1_000 }));
    await flush();
    await wait(1_000);
    expect(result.current).toMatchObject({ data: 7, misses: 1, stale: false });
    expect(result.current.error?.kind).toBe('unreachable');
    await wait(1_000);
    expect(result.current).toMatchObject({ data: 7, misses: 2, stale: true });
    await wait(1_000);
    expect(result.current).toMatchObject({ data: 8, misses: 0, stale: false, error: undefined });
  });

  it('reports an error without data (unreachable at first load), never stale', async () => {
    const s = scripted();
    s.queue.push(new ApiError('unreachable', 'down'), new ApiError('unreachable', 'down'));
    const { result } = renderHook(() => usePoll(s.load, vi.fn(), { intervalMs: 1_000 }));
    await flush();
    await wait(1_000);
    expect(result.current).toMatchObject({
      data: undefined,
      loading: false,
      stale: false,
      misses: 2,
    });
  });

  it('pauses the schedule, and resuming fetches at once', async () => {
    const s = scripted();
    s.queue.push(1, 2);
    const { result } = renderHook(() => usePoll(s.load, vi.fn(), { intervalMs: 1_000 }));
    await flush();
    act(() => {
      result.current.setPaused(true);
    });
    await wait(10_000);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(result.current.paused).toBe(true);
    act(() => {
      result.current.setPaused(false);
    });
    await flush();
    expect(s.load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(2);
  });

  it('refreshes now, even while paused', async () => {
    const s = scripted();
    s.queue.push(1, 2);
    const { result } = renderHook(() => usePoll(s.load, vi.fn(), { intervalMs: 5_000 }));
    await flush();
    act(() => {
      result.current.setPaused(true);
    });
    act(() => {
      result.current.refresh();
    });
    await flush();
    expect(result.current.data).toBe(2);
    await wait(20_000);
    expect(s.load).toHaveBeenCalledTimes(2);
  });

  it('hands a 401 to onUnauthorized and stops polling', async () => {
    const s = scripted();
    s.queue.push(new ApiError('unauthorized', 'no', 401));
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => usePoll(s.load, onUnauthorized, { intervalMs: 1_000 }));
    await flush();
    await wait(10_000);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeUndefined();
  });

  it('counts a poll that outlives the interval as a miss, then polls again', async () => {
    const s = scripted();
    s.queue.push('hang', 5);
    const { result } = renderHook(() => usePoll(s.load, vi.fn(), { intervalMs: 1_000 }));
    await wait(1_000);
    expect(result.current.misses).toBe(1);
    expect(result.current.error?.kind).toBe('unreachable');
    expect(s.load.mock.calls[0]?.[0].aborted).toBe(true);
    await wait(1_000);
    expect(result.current).toMatchObject({ data: 5, misses: 0 });
  });

  it('aborts the in-flight poll on unmount', async () => {
    const s = scripted();
    s.queue.push('hang');
    const { unmount } = renderHook(() => usePoll(s.load, vi.fn()));
    await flush();
    const signal = s.load.mock.calls[0]?.[0];
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
