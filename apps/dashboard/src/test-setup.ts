import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library can't register its own cleanup. Node-environment tests
// (e.g. the token contrast check) have no window.
afterEach(() => {
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
});
