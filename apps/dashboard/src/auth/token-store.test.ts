import { describe, expect, it } from 'vitest';
import { createTokenStore, TOKEN_KEY } from './token-store.ts';

describe('token store (ADR-0037: sessionStorage only)', () => {
  it('keeps the token in sessionStorage and never in localStorage', () => {
    const store = createTokenStore();
    store.set('secret-token');
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe('secret-token');
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(createTokenStore().get()).toBe('secret-token');
  });

  it('clears the token', () => {
    const store = createTokenStore();
    store.set('secret-token');
    store.clear();
    expect(store.get()).toBeUndefined();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('falls back to memory when storage is unavailable', () => {
    const store = createTokenStore(() => {
      throw new Error('SecurityError');
    });
    expect(store.get()).toBeUndefined();
    store.set('secret-token');
    expect(store.get()).toBe('secret-token');
    store.clear();
    expect(store.get()).toBeUndefined();
  });

  it('keeps working when writes fail (quota)', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    const store = createTokenStore(() => failing);
    store.set('secret-token');
    expect(store.get()).toBe('secret-token');
  });
});
