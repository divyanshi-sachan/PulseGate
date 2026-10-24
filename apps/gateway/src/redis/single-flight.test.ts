import { describe, expect, it } from 'vitest';
import { singleFlight } from './single-flight.ts';

describe('singleFlight (ADR-0034 review)', () => {
  it('shares one in-flight call between concurrent callers', async () => {
    let calls = 0;
    let release: (value: boolean) => void = () => undefined;
    const check = singleFlight(() => {
      calls++;
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const results = Promise.all(Array.from({ length: 20 }, () => check()));
    release(true);
    expect(await results).toEqual(Array.from({ length: 20 }, () => true));
    expect(calls).toBe(1);
  });

  it('starts a fresh call once the previous one settled, including after a failure', async () => {
    let calls = 0;
    const check = singleFlight(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve('up');
    });
    await expect(check()).rejects.toThrow('down');
    await expect(check()).resolves.toBe('up');
    expect(calls).toBe(2);
  });
});
